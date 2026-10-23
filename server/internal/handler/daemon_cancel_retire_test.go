package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func mul8188Fixture(t *testing.T, number int32) (agentID, runtimeID, issueID string) {
	t.Helper()
	ctx := context.Background()
	if err := testPool.QueryRow(ctx, `
		SELECT a.id, a.runtime_id FROM agent a WHERE a.workspace_id = $1 LIMIT 1
	`, testWorkspaceID).Scan(&agentID, &runtimeID); err != nil {
		t.Fatalf("setup: get agent: %v", err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_id, creator_type, number, position)
		VALUES ($1, 'mul-8188 fixture', 'in_progress', 'none', $2, 'member', $3, 0)
		RETURNING id
	`, testWorkspaceID, testUserID, number).Scan(&issueID); err != nil {
		t.Fatalf("setup: create issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})
	return agentID, runtimeID, issueID
}

func insertMUL8188Task(t *testing.T, agentID, runtimeID, issueID, status, sessionID, failureReason, errText string) string {
	t.Helper()
	var taskID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, started_at, completed_at, session_id, failure_reason, error)
		VALUES ($1, $2, $3, $4, 0, now(), now(), $5, NULLIF($6, ''), NULLIF($7, ''))
		RETURNING id
	`, agentID, runtimeID, issueID, status, sessionID, failureReason, errText).Scan(&taskID); err != nil {
		t.Fatalf("setup: create task: %v", err)
	}
	return taskID
}

func postCancelAck(t *testing.T, taskID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+taskID+"/cancel-ack", body)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("taskId", taskID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	testHandler.AckTaskCancelled(w, req)
	return w
}

func lastIssueSession(t *testing.T, agentID, issueID string) (string, bool) {
	t.Helper()
	got, err := testHandler.Queries.GetLastTaskSession(context.Background(), db.GetLastTaskSessionParams{
		AgentID: parseUUID(agentID),
		IssueID: parseUUID(issueID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false
	}
	if err != nil {
		t.Fatalf("GetLastTaskSession: %v", err)
	}
	return got.SessionID.String, true
}

// TestCancelAck_RetiresSilentResumedSession is the server half of MUL-8188's
// "keeps resuming the broken session" loop. Before the fix the issue looked
// like this: an earlier failure (provider 5xx — resume-safe) and then a chain
// of hand-cancelled runs, all naming the same session. Every row was a valid
// resume source, so each trigger resumed it again.
func TestCancelAck_RetiresSilentResumedSession(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID, runtimeID, issueID := mul8188Fixture(t, 81881)

	insertMUL8188Task(t, agentID, runtimeID, issueID, "failed", "ses_broken", "agent_error.provider_server_error",
		"kiro session/prompt failed: session/prompt: Internal error (code=-32603, data=dispatch failure)")
	cancelled := insertMUL8188Task(t, agentID, runtimeID, issueID, "cancelled", "ses_broken", "", "")

	if got, ok := lastIssueSession(t, agentID, issueID); !ok || got != "ses_broken" {
		t.Fatalf("precondition: resume pointer = %q (%v), want ses_broken", got, ok)
	}

	if w := postCancelAck(t, cancelled, map[string]any{"retired_session_id": "ses_broken"}); w.Code != http.StatusOK {
		t.Fatalf("cancel-ack: %d %s", w.Code, w.Body.String())
	}

	var retired string
	if err := testPool.QueryRow(context.Background(), `
		SELECT COALESCE(retired_session_id, '') FROM agent_task_queue WHERE id = $1
	`, cancelled).Scan(&retired); err != nil {
		t.Fatalf("read task: %v", err)
	}
	if retired != "ses_broken" {
		t.Fatalf("retired_session_id = %q, want ses_broken", retired)
	}
	if got, ok := lastIssueSession(t, agentID, issueID); ok && got == "ses_broken" {
		t.Fatal("the undrivable session is still offered as the resume pointer")
	}

	// Replay is idempotent and never overwrites.
	if w := postCancelAck(t, cancelled, map[string]any{"retired_session_id": "ses_other"}); w.Code != http.StatusOK {
		t.Fatalf("replayed cancel-ack: %d %s", w.Code, w.Body.String())
	}
	if err := testPool.QueryRow(context.Background(), `
		SELECT COALESCE(retired_session_id, '') FROM agent_task_queue WHERE id = $1
	`, cancelled).Scan(&retired); err != nil {
		t.Fatalf("read task: %v", err)
	}
	if retired != "ses_broken" {
		t.Fatalf("replay overwrote retired_session_id: %q", retired)
	}
}

// TestCancelAck_RetiredSessionIgnoredOnNonCancelledRow: the status CAS keeps a
// stale ack from retiring the session of a completed run.
func TestCancelAck_RetiredSessionIgnoredOnNonCancelledRow(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID, runtimeID, issueID := mul8188Fixture(t, 81882)
	completed := insertMUL8188Task(t, agentID, runtimeID, issueID, "completed", "ses_healthy", "", "")

	if w := postCancelAck(t, completed, map[string]any{"retired_session_id": "ses_healthy"}); w.Code != http.StatusOK {
		t.Fatalf("cancel-ack: %d %s", w.Code, w.Body.String())
	}
	if got, ok := lastIssueSession(t, agentID, issueID); !ok || got != "ses_healthy" {
		t.Fatalf("resume pointer = %q (%v), want ses_healthy to stay resumable", got, ok)
	}
}

// TestCancelAck_RetiredSessionClearsChatPointer: a chat turn resumes from
// chat_session.session_id first, so the pointer must be cleared too — but
// only while it still names the retired session.
func TestCancelAck_RetiredSessionClearsChatPointer(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var agentID, runtimeID string
	if err := testPool.QueryRow(ctx, `
		SELECT a.id, a.runtime_id FROM agent a WHERE a.workspace_id = $1 LIMIT 1
	`, testWorkspaceID).Scan(&agentID, &runtimeID); err != nil {
		t.Fatalf("setup: get agent: %v", err)
	}
	chatSessionID := dbfx.ChatSession(t, agentID, nil)
	if _, err := testPool.Exec(ctx, `UPDATE chat_session SET session_id = 'ses_broken', runtime_id = $2 WHERE id = $1`, chatSessionID, runtimeID); err != nil {
		t.Fatalf("setup: pin chat session: %v", err)
	}
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, chat_session_id, status, priority, started_at, completed_at, session_id)
		VALUES ($1, $2, $3, 'cancelled', 0, now(), now(), 'ses_broken')
		RETURNING id
	`, agentID, runtimeID, chatSessionID).Scan(&taskID); err != nil {
		t.Fatalf("setup: create task: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })

	if w := postCancelAck(t, taskID, map[string]any{"retired_session_id": "ses_broken"}); w.Code != http.StatusOK {
		t.Fatalf("cancel-ack: %d %s", w.Code, w.Body.String())
	}
	var pointer *string
	if err := testPool.QueryRow(ctx, `SELECT session_id FROM chat_session WHERE id = $1`, chatSessionID).Scan(&pointer); err != nil {
		t.Fatalf("read chat session: %v", err)
	}
	if pointer != nil && *pointer == "ses_broken" {
		t.Fatal("chat resume pointer still names the retired session")
	}
}

// TestGetLastTaskSession_ExcludesInvalidConversationHistory pins the
// server-side text guard for rows an older daemon classified as resume-safe:
// Kiro's "invalid conversation history" panic must never be resumed again.
func TestGetLastTaskSession_ExcludesInvalidConversationHistory(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	agentID, runtimeID, issueID := mul8188Fixture(t, 81883)
	insertMUL8188Task(t, agentID, runtimeID, issueID, "failed", "ses_broken", "agent_error.unknown",
		`kiro runtime panicked: The application panicked (crashed). | Message:  first agent loop request should never fail: AgentLoopResponse(Custom("invalid conversation history received"))`)

	if got, ok := lastIssueSession(t, agentID, issueID); ok && got == "ses_broken" {
		t.Fatal("a session Kiro reported as invalid history is still offered as the resume pointer")
	}
}
