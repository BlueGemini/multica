package handler

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestBootstrapOnboardingRuntimeWaitsForRuntimeAccessChange(t *testing.T) {
	if testHandler == nil {
		t.Fatal("database-backed handler fixture is required")
	}
	workspaceID := dbfx.Workspace(t, "Legacy onboarding visibility", "onboarding-visibility-"+uuid.NewString())
	ownerID := dbfx.User(t, "Runtime owner", uuid.NewString()+"@multica.test")
	memberID := dbfx.User(t, "Onboarding member", uuid.NewString()+"@multica.test")
	dbfx.Member(t, workspaceID, ownerID, "owner")
	dbfx.Member(t, workspaceID, memberID, "member")
	fx := testutil.New(testPool, workspaceID, memberID)
	runtimeID := fx.Runtime(t, "Shared onboarding runtime", testutil.Cols{
		"owner_id": ownerID, "visibility": "public",
	})
	// Also clean up writes made if a regression lets the bootstrap succeed.
	fx.Cleanup(t, `DELETE FROM agent WHERE workspace_id = $1`, workspaceID)
	fx.Cleanup(t, `DELETE FROM issue WHERE workspace_id = $1`, workspaceID)
	fx.Cleanup(t, `DELETE FROM agent_task_queue WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = $1)`, workspaceID)
	req := newRequestAs(memberID, http.MethodPost, "/api/me/onboarding/runtime-bootstrap", map[string]string{
		"workspace_id": workspaceID,
		"runtime_id":   runtimeID,
	})
	ctx, cancel := context.WithTimeout(req.Context(), 20*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin runtime privacy change: %v", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := db.New(tx).LockAgentRuntimeForAccessChange(ctx, parseUUID(runtimeID)); err != nil {
		t.Fatalf("lock shared runtime for privacy change: %v", err)
	}
	holderPID := holderBackendPID(t, ctx, tx)
	responses := make(chan *testutil.Response, 1)
	go func() { responses <- testutil.Call(t, testHandler.BootstrapOnboardingRuntime, req) }()

	// Observe a row-lock waiter attributed to this transaction, rather than
	// assuming the request reached authorization after an arbitrary sleep.
	if !waitForWaiterBlockedBy(t, holderPID, 10*time.Second) {
		select {
		case response := <-responses:
			t.Fatalf("bootstrap returned %d while runtime access was locked: %s", response.Code, response.Text())
		default:
			t.Fatal("bootstrap did not wait for the runtime access lock")
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_runtime SET visibility = 'private' WHERE id = $1`, runtimeID); err != nil {
		t.Fatalf("make locked runtime private: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit runtime privacy change: %v", err)
	}
	select {
	case response := <-responses:
		response.Want(http.StatusForbidden)
	case <-ctx.Done():
		t.Fatal("bootstrap did not finish after the runtime access lock was released")
	}
	if got := fx.Count(t, `SELECT count(*) FROM agent WHERE workspace_id = $1`, workspaceID); got != 0 {
		t.Fatalf("rejected bootstrap created %d agents", got)
	}
	if got := fx.Count(t, `SELECT count(*) FROM issue WHERE workspace_id = $1`, workspaceID); got != 0 {
		t.Fatalf("rejected bootstrap created %d onboarding issues", got)
	}
	if got := fx.Count(t, `SELECT count(*) FROM "user" WHERE id = $1 AND onboarded_at IS NOT NULL`, memberID); got != 0 {
		t.Fatal("rejected bootstrap marked the user onboarded")
	}
}
