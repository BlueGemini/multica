package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func cleanupAgentDrafts(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent_draft WHERE workspace_id = $1`, testWorkspaceID)
	})
}

func createDraftAs(t *testing.T, req *http.Request) AgentDraftResponse {
	t.Helper()
	var draft AgentDraftResponse
	testutil.Call(t, testHandler.CreateAgentDraft, req).Want(http.StatusCreated).JSON(&draft)
	return draft
}

func asTaskAgent(req *http.Request, agentID, taskID string) *http.Request {
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)
	return req
}

func TestAgentDraftPartialUpdatesMergeAndListForOwner(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)

	draft := createDraftAs(t, newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{
		"config": map[string]any{"name": "  Weekly reporter ", "instructions": "Summarise the week."},
	}))
	if draft.OwnerID != testUserID || draft.AuthorType != "member" || draft.AuthorID != testUserID {
		t.Fatalf("unexpected ownership: %+v", draft)
	}
	if draft.Config.Name != "Weekly reporter" || draft.Config.PermissionScope != "private" {
		t.Fatalf("config not normalised: %+v", draft.Config)
	}
	if draft.Mention != "[Weekly reporter](mention://agent-draft/"+draft.ID+")" {
		t.Fatalf("mention = %q", draft.Mention)
	}

	var updated AgentDraftResponse
	testutil.Call(t, testHandler.UpdateAgentDraft, withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"description": "Writes the weekly report", "runtime_id": testRuntimeID},
	}), "id", draft.ID)).Want(http.StatusOK).JSON(&updated)
	if updated.Config.Instructions != "Summarise the week." || updated.Config.Description != "Writes the weekly report" || updated.Config.RuntimeID != testRuntimeID {
		t.Fatalf("partial update lost fields: %+v", updated.Config)
	}
	if updated.Version != draft.Version+1 {
		t.Fatalf("version = %d, want %d", updated.Version, draft.Version+1)
	}

	var list ListAgentDraftsResponse
	testutil.Call(t, testHandler.ListAgentDrafts, newRequest(http.MethodGet, "/api/agent-drafts", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Drafts) != 1 || list.Drafts[0].ID != draft.ID {
		t.Fatalf("list = %+v", list.Drafts)
	}

	other := createPermissionTestMember(t, "agent-draft-other@multica.test")
	testutil.Call(t, testHandler.ListAgentDrafts, newRequestAs(other, http.MethodGet, "/api/agent-drafts", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Drafts) != 0 {
		t.Fatalf("another member listed someone else's drafts: %+v", list.Drafts)
	}
}

func TestAgentDraftRejectsInvalidConfig(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)

	for name, config := range map[string]map[string]any{
		"unknown field":     {"custom_env": map[string]string{"TOKEN": "x"}},
		"bad scope":         {"permission_scope": "everyone"},
		"foreign runtime":   {"runtime_id": "00000000-0000-0000-0000-000000000001"},
		"malformed skill":   {"skill_ids": []string{"not-a-uuid"}},
		"too many starters": {"conversation_starters": []map[string]string{{"label": "a", "prompt": "a"}, {"label": "b", "prompt": "b"}, {"label": "c", "prompt": "c"}, {"label": "d", "prompt": "d"}}},
	} {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, testHandler.CreateAgentDraft, newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{"config": config})).Want(http.StatusBadRequest)
		})
	}
}

func TestAgentDraftOnlyOwnerCanChangeIt(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)

	draft := createDraftAs(t, newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{
		"config": map[string]any{"name": "Owner only"},
	}))
	other := createPermissionTestMember(t, "agent-draft-intruder@multica.test")

	testutil.Call(t, testHandler.GetAgentDraft, withURLParam(newRequestAs(other, http.MethodGet, "/api/agent-drafts/"+draft.ID, nil), "id", draft.ID)).Want(http.StatusOK)
	testutil.Call(t, testHandler.UpdateAgentDraft, withURLParam(newRequestAs(other, http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"name": "Hijacked"},
	}), "id", draft.ID)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.DiscardAgentDraft, withURLParam(newRequestAs(other, http.MethodPost, "/api/agent-drafts/"+draft.ID+"/discard", nil), "id", draft.ID)).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.CreateAgent, newRequestAs(other, http.MethodPost, "/api/agents", map[string]any{
		"name": "Hijacked agent", "runtime_id": testRuntimeID, "draft_id": draft.ID,
	})).Want(http.StatusForbidden)

	var discarded AgentDraftResponse
	testutil.Call(t, testHandler.DiscardAgentDraft, withURLParam(newRequest(http.MethodPost, "/api/agent-drafts/"+draft.ID+"/discard", nil), "id", draft.ID)).Want(http.StatusOK).JSON(&discarded)
	if discarded.Status != "discarded" {
		t.Fatalf("status = %q", discarded.Status)
	}
	testutil.Call(t, testHandler.UpdateAgentDraft, withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"name": "Too late"},
	}), "id", draft.ID)).Want(http.StatusConflict)
}

func TestAgentDraftFromAgentIsConfirmedOnlyByItsMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)
	const agentName = "Draft confirmed agent"
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, agentName)
	})

	authorID := createHandlerTestAgent(t, "draft-author-agent", nil)
	issueID := dbfx.Issue(t, "Need a weekly reporter")
	taskID := dbfx.Task(t, authorID, testutil.Cols{"issue_id": issueID, "runtime_id": testRuntimeID})

	draft := createDraftAs(t, asTaskAgent(newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{
		"config": map[string]any{"name": agentName, "runtime_id": testRuntimeID},
	}), authorID, taskID))
	if draft.OwnerID != testUserID || draft.AuthorType != "agent" || draft.AuthorID != authorID {
		t.Fatalf("unexpected ownership: %+v", draft)
	}
	if draft.SourceIssueID == nil || *draft.SourceIssueID != issueID {
		t.Fatalf("source_issue_id = %v, want %s", draft.SourceIssueID, issueID)
	}

	// The agent can keep refining the draft for its member...
	testutil.Call(t, testHandler.UpdateAgentDraft, asTaskAgent(withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"description": "Writes the weekly report"},
	}), "id", draft.ID), authorID, taskID)).Want(http.StatusOK)

	// ...but cannot turn it into an agent.
	testutil.Call(t, testHandler.CreateAgent, asTaskAgent(newRequest(http.MethodPost, "/api/agents", map[string]any{
		"name": agentName, "runtime_id": testRuntimeID, "draft_id": draft.ID,
	}), authorID, taskID)).Want(http.StatusForbidden)

	var created AgentResponse
	testutil.Call(t, testHandler.CreateAgent, newRequest(http.MethodPost, "/api/agents", map[string]any{
		"name": agentName, "runtime_id": testRuntimeID, "draft_id": draft.ID,
	})).Want(http.StatusCreated).JSON(&created)

	var after AgentDraftResponse
	testutil.Call(t, testHandler.GetAgentDraft, withURLParam(newRequest(http.MethodGet, "/api/agent-drafts/"+draft.ID, nil), "id", draft.ID)).Want(http.StatusOK).JSON(&after)
	if after.Status != "created" || after.CreatedAgentID == nil || *after.CreatedAgentID != created.ID {
		t.Fatalf("draft after create = %+v", after)
	}

	testutil.Call(t, testHandler.CreateAgent, newRequest(http.MethodPost, "/api/agents", map[string]any{
		"name": agentName + " again", "runtime_id": testRuntimeID, "draft_id": draft.ID,
	})).Want(http.StatusConflict)
	if n := dbfx.Count(t, `SELECT count(*) FROM agent WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, agentName+" again"); n != 0 {
		t.Fatalf("a consumed draft still created an agent")
	}
}

func TestAgentDraftRevisionsRecordOnlyAgentWrites(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)

	authorID := createHandlerTestAgent(t, "draft-revision-agent", nil)
	issueID := dbfx.Issue(t, "Need a PR reviewer")
	taskID := dbfx.Task(t, authorID, testutil.Cols{"issue_id": issueID, "runtime_id": testRuntimeID})
	patch := func(req *http.Request) AgentDraftResponse {
		var out AgentDraftResponse
		testutil.Call(t, testHandler.UpdateAgentDraft, req).Want(http.StatusOK).JSON(&out)
		return out
	}

	draft := createDraftAs(t, asTaskAgent(newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{
		"config":     map[string]any{"name": "PR reviewer", "instructions": "Comment only."},
		"follow_ups": []map[string]string{{"kind": "env", "label": "GITHUB_TOKEN", "hint": "Only you can fill it in"}},
	}), authorID, taskID))
	if draft.Revision != 1 || len(draft.Revisions) != 1 || draft.Mention != "[PR reviewer](mention://agent-draft/"+draft.ID+"?rev=1)" {
		t.Fatalf("first revision: rev=%d revisions=%d mention=%q", draft.Revision, len(draft.Revisions), draft.Mention)
	}
	if len(draft.FollowUps) != 1 || draft.FollowUps[0].Label != "GITHUB_TOKEN" {
		t.Fatalf("follow_ups = %+v", draft.FollowUps)
	}

	// The member's own edit changes the draft but is not a revision.
	edited := patch(withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"description": "Reviews frontend PRs"},
	}), "id", draft.ID))
	if edited.Revision != 1 || edited.Version != draft.Version+1 {
		t.Fatalf("member edit: rev=%d version=%d", edited.Revision, edited.Version)
	}

	// The agent's change is revision 2 and records what it replaced.
	revised := patch(asTaskAgent(withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"instructions": "Request changes for accessibility issues."},
	}), "id", draft.ID), authorID, taskID))
	if revised.Revision != 2 || len(revised.Revisions) != 2 {
		t.Fatalf("agent revision: rev=%d revisions=%d", revised.Revision, len(revised.Revisions))
	}
	latest := revised.Revisions[1]
	if string(latest.Previous["instructions"]) != `"Comment only."` || len(latest.Previous) != 1 {
		t.Fatalf("previous = %v", latest.Previous)
	}
	if revised.FollowUps[0].Label != "GITHUB_TOKEN" {
		t.Fatalf("follow_ups dropped by a config-only write: %+v", revised.FollowUps)
	}

	// An agent write that changes nothing is not a revision either.
	same := patch(asTaskAgent(withURLParam(newRequest(http.MethodPatch, "/api/agent-drafts/"+draft.ID, map[string]any{
		"config": map[string]any{"instructions": "Request changes for accessibility issues."},
	}), "id", draft.ID), authorID, taskID))
	if same.Revision != 2 {
		t.Fatalf("no-op agent write bumped revision to %d", same.Revision)
	}

	var list ListAgentDraftsResponse
	testutil.Call(t, testHandler.ListAgentDrafts, newRequest(http.MethodGet, "/api/agent-drafts", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Drafts) != 1 || list.Drafts[0].Revisions != nil {
		t.Fatalf("list should omit revision history: %+v", list.Drafts)
	}

	var rejected AgentDraftResponse
	testutil.Call(t, testHandler.DiscardAgentDraft, withURLParam(newRequest(http.MethodPost, "/api/agent-drafts/"+draft.ID+"/discard", map[string]any{
		"reason": "We already have a reviewer",
	}), "id", draft.ID)).Want(http.StatusOK).JSON(&rejected)
	if rejected.Status != "discarded" || rejected.DiscardReason != "We already have a reviewer" {
		t.Fatalf("rejected = %+v", rejected)
	}
}

func TestAgentDraftRejectsInvalidFollowUps(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	cleanupAgentDrafts(t)

	for name, items := range map[string][]map[string]string{
		"bad kind":    {{"kind": "secret", "label": "X"}},
		"bad env key": {{"kind": "env", "label": "NOT A KEY"}},
		"empty label": {{"kind": "note", "label": "  "}},
	} {
		t.Run(name, func(t *testing.T) {
			testutil.Call(t, testHandler.CreateAgentDraft, newRequest(http.MethodPost, "/api/agent-drafts", map[string]any{
				"config": map[string]any{"name": "x"}, "follow_ups": items,
			})).Want(http.StatusBadRequest)
		})
	}
}
