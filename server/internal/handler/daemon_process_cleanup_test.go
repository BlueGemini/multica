package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/taskfailure"
)

func TestProcessCleanupFence(t *testing.T) {
	if testHandler == nil {
		t.Fatal("PostgreSQL is required")
	}
	agentID := dbfx.Agent(t, "cleanup-fenced agent", testRuntimeID)
	issue := dbfx.Issue(t, "process cleanup fence")
	unsafe := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "failed",
		"failure_reason": "cleanup_unconfirmed", "completed_at": testutil.Raw("now() - interval '1 minute'"),
	})
	queued := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched", "dispatched_at": time.Now().UTC(),
	})
	req := withURLParam(newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+queued+"/start", nil), "taskId", queued)
	testutil.Call(t, testHandler.StartTask, req).Want(http.StatusConflict)
	var status, reason string
	dbfx.QueryRow(t, `SELECT status, failure_reason FROM agent_task_queue WHERE id=$1`, queued).Scan(&status, &reason)
	if status != "failed" || reason != "cleanup_blocked" {
		t.Fatalf("automatic successor = %s/%s", status, reason)
	}
	manual := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched",
		"rerun_of_task_id": unsafe, "initiator_user_id": testUserID,
	})
	blocked, err := testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(manual))
	if err != nil || blocked {
		t.Fatalf("new manual rerun blocked=%v err=%v", blocked, err)
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='completed' WHERE id=$1`, manual)
	next := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched"})
	blocked, err = testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(next))
	if err != nil || blocked {
		t.Fatalf("successful manual recovery did not release fence: blocked=%v err=%v", blocked, err)
	}
}

func TestProcessCleanupCancelAckUnconfirmed(t *testing.T) {
	if testHandler == nil {
		t.Fatal("PostgreSQL is required")
	}
	agentID := dbfx.Agent(t, "cancel cleanup agent", testRuntimeID)
	issue := dbfx.Issue(t, "cancel cleanup")
	task := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "cancelled",
		"started_at":   testutil.Raw("now() - interval '1 minute'"),
		"completed_at": testutil.Raw("now()"), "result": `{"process_cleanup_pending":true}`,
	})
	for range 2 { // Lost acknowledgement/replay must not duplicate failure output.
		ackCancelled(t, task, map[string]any{
			"failure_reason": taskfailure.ReasonProcessCleanupUnconfirmed.String(),
			"error_message":  "Background processes may still be running; check before manually rerunning.",
		})
	}
	var status, reason, message string
	var pending bool
	dbfx.QueryRow(t, `SELECT status, failure_reason, error, COALESCE(result->>'process_cleanup_pending'='true',false) FROM agent_task_queue WHERE id=$1`, task).Scan(&status, &reason, &message, &pending)
	if status != "failed" || reason != "cleanup_unconfirmed" || pending || !strings.Contains(message, "Background processes") {
		t.Fatalf("cancel-ack lost cleanup failure: status=%s reason=%s pending=%v error=%s", status, reason, pending, message)
	}
	var attempts int
	dbfx.QueryRow(t, `SELECT count(*) FROM agent_task_queue WHERE retry_of_task_id=$1`, task).Scan(&attempts)
	if attempts != 0 {
		t.Fatal("cleanup failure created an automatic retry")
	}
}

func TestProcessCleanupPendingDefersSuccessor(t *testing.T) {
	if testHandler == nil {
		t.Fatal("PostgreSQL is required")
	}
	agentID := dbfx.Agent(t, "pending cleanup agent", testRuntimeID)
	issue := dbfx.Issue(t, "pending cleanup")
	stopping := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "cancelled",
		"started_at": testutil.Raw("now() - interval '1 minute'"), "completed_at": testutil.Raw("now()"),
		"result": `{"process_cleanup_pending":true}`,
	})
	successor := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched", "dispatched_at": time.Now().UTC(),
	})
	var generation pgtype.Timestamptz
	dbfx.QueryRow(t, `SELECT dispatched_at FROM agent_task_queue WHERE id=$1`, successor).Scan(&generation)
	testutil.Call(t, testHandler.StartTask, startClaimRequest(successor, testRuntimeID, generation.Time.Add(-time.Microsecond))).Want(http.StatusConflict)
	var before string
	dbfx.QueryRow(t, `SELECT status FROM agent_task_queue WHERE id=$1`, successor).Scan(&before)
	if before != "dispatched" {
		t.Fatal("a stale start changed another delivery's claim")
	}
	testutil.Call(t, testHandler.StartTask, withURLParam(newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+successor+"/start", nil), "taskId", successor)).Want(http.StatusConflict)
	var state string
	dbfx.QueryRow(t, `SELECT status FROM agent_task_queue WHERE id=$1`, successor).Scan(&state)
	if state != "queued" {
		t.Fatalf("successor was not deferred: %s", state)
	}
	ackCancelled(t, stopping, map[string]any{"process_cleanup_confirmed": true})
	dbfx.Exec(t, `UPDATE agent_task_queue SET status='dispatched',dispatched_at=now() WHERE id=$1`, successor)
	testutil.Call(t, testHandler.StartTask, withURLParam(newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+successor+"/start", nil), "taskId", successor)).Want(http.StatusOK)
}

func TestProcessCleanupMissingAcknowledgement(t *testing.T) {
	if testHandler == nil {
		t.Fatal("PostgreSQL is required")
	}
	runtime := dbfx.Runtime(t, "Pi cleanup runtime", testutil.Cols{"provider": "pi"})
	agentID := dbfx.Agent(t, "Pi cleanup acknowledgement", runtime)
	issue := dbfx.Issue(t, "cleanup acknowledgement")
	id := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtime, "issue_id": issue, "status": "running",
		"started_at": testutil.Raw("now() - interval '1 minute'"),
	})
	if _, err := testHandler.TaskService.CancelTask(context.Background(), parseUUID(id)); err != nil {
		t.Fatal(err)
	}
	var pending bool
	dbfx.QueryRow(t, `SELECT result->>'process_cleanup_pending'='true' FROM agent_task_queue WHERE id=$1`, id).Scan(&pending)
	if !pending {
		t.Fatal("cancellation released its execution fence before cleanup")
	}
	ackCancelled(t, id, map[string]any{}) // Older daemons cannot assert cleanup.
	var state, reason string
	dbfx.QueryRow(t, `SELECT status, failure_reason FROM agent_task_queue WHERE id=$1`, id).Scan(&state, &reason)
	if state != "failed" || reason != "cleanup_unconfirmed" {
		t.Fatalf("missing cleanup acknowledgement = %s/%s", state, reason)
	}
}

func TestProcessCleanupExpiredAcknowledgementStaysBlocked(t *testing.T) {
	if testHandler == nil {
		t.Fatal("PostgreSQL is required")
	}
	agentID := dbfx.Agent(t, "expired cleanup agent", testRuntimeID)
	issue := dbfx.Issue(t, "expired cleanup")
	stopping := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "cancelled",
		"completed_at": testutil.Raw("now() - interval '1 minute'"),
		"result":       `{"process_cleanup_pending":true}`,
	})
	next := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched",
	})
	blocked, err := testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(next))
	if err != nil || !blocked {
		t.Fatalf("expired acknowledgement released automatic work: blocked=%v err=%v", blocked, err)
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET rerun_of_task_id=$2,created_at=now()-interval '45 seconds' WHERE id=$1`, next, stopping)
	blocked, err = testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(next))
	if err != nil || !blocked {
		t.Fatalf("a rerun queued before cleanup became unconfirmed bypassed the fence: blocked=%v err=%v", blocked, err)
	}
	dbfx.Exec(t, `UPDATE agent_task_queue SET created_at=now() WHERE id=$1`, next)
	blocked, err = testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(next))
	if err != nil || blocked {
		t.Fatalf("new explicit recovery was refused: blocked=%v err=%v", blocked, err)
	}
	other := dbfx.Agent(t, "unrelated cleanup agent", testRuntimeID)
	otherTask := dbfx.Task(t, other, testutil.Cols{"runtime_id": testRuntimeID, "issue_id": issue, "status": "dispatched"})
	blocked, err = testHandler.Queries.TaskBlockedByProcessCleanup(context.Background(), parseUUID(otherTask))
	if err != nil || blocked {
		t.Fatalf("cleanup fence affected another agent: blocked=%v err=%v", blocked, err)
	}
}
