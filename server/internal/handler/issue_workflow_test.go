package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

// Project workflow tests (MUL-7420).

// workflowTestSuffix keeps names unique across tests sharing the workspace.
func workflowTestSuffix() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func workflowRequest(method, path string, body any) *http.Request {
	return newRequest(method, path+"?workspace_id="+testWorkspaceID, body)
}

// statusSteps names a workflow's own steps by status key.
func statusSteps(keys ...string) []map[string]any {
	out := make([]map[string]any, len(keys))
	for i, key := range keys {
		out[i] = map[string]any{"status_key": key}
	}
	return out
}

// createTestWorkflow creates a workflow through the API and deletes it after
// the test, detaching any project still using it first.
func createTestWorkflow(t *testing.T, name string, middle ...string) IssueWorkflowResponse {
	t.Helper()
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	var created IssueWorkflowResponse
	testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", map[string]any{
		"name":  name,
		"steps": statusSteps(middle...),
	})).Want(http.StatusCreated).JSON(&created)
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `UPDATE project SET workflow_id = NULL WHERE workflow_id = $1`, created.ID)
		testPool.Exec(ctx, `DELETE FROM issue_workflow WHERE id = $1`, created.ID)
	})
	return created
}

// resetDefaultWorkflow drops the shared workspace's stored Default after the
// test, so the next test snapshots its own.
func resetDefaultWorkflow(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_workflow WHERE workspace_id = $1 AND is_default`, testWorkspaceID)
	})
}

func createWorkflowTestProject(t *testing.T, title string) string {
	t.Helper()
	projectID := dbfx.Project(t, title)
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM issue_workflow WHERE id = (SELECT workflow_id FROM project WHERE id = $1)
			AND NOT EXISTS (SELECT 1 FROM project p WHERE p.workflow_id = issue_workflow.id AND p.id <> $1)`, projectID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE project_id = $1`, projectID)
		testPool.Exec(ctx, `DELETE FROM project WHERE id = $1`, projectID)
	})
	return projectID
}

func setProjectWorkflow(t *testing.T, projectID string, body map[string]any) *testutil.Response {
	t.Helper()
	req := withURLParam(workflowRequest("POST", "/api/projects/"+projectID+"/workflow", body), "id", projectID)
	return testutil.Call(t, testHandler.SetProjectWorkflow, req)
}

func setProjectHandoff(t *testing.T, projectID, statusKey string, body map[string]any) *testutil.Response {
	t.Helper()
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	req := withURLParams(workflowRequest("PUT", "/api/projects/"+projectID+"/workflow/handoffs/"+statusKey, body),
		"id", projectID, "status", statusKey)
	return testutil.Call(t, testHandler.SetProjectWorkflowHandoff, req)
}

func handToAgent(agentID, instructions string) map[string]any {
	return map[string]any{"handler": map[string]any{"type": "agent", "id": agentID}, "instructions": instructions}
}

func updateIssueForTest(t *testing.T, issueID string, body map[string]any) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest("PUT", "/api/issues/"+issueID, body), "id", issueID)
	return testutil.Call(t, testHandler.UpdateIssue, req)
}

func issueStatusAndAssignee(t *testing.T, issueID string) (status, assigneeType, assigneeID string) {
	t.Helper()
	var at, aid *string
	dbfx.QueryRow(t, `SELECT status, assignee_type, assignee_id::text FROM issue WHERE id = $1`, issueID).Scan(&status, &at, &aid)
	if at != nil {
		assigneeType = *at
	}
	if aid != nil {
		assigneeID = *aid
	}
	return status, assigneeType, assigneeID
}

// deliveryProject is the design's simplest case: a project on Default that
// hands in_progress to an agent and keeps everything else as is.
func deliveryProject(t *testing.T, title, agentID string) string {
	t.Helper()
	projectID := createWorkflowTestProject(t, title)
	setProjectHandoff(t, projectID, "in_progress", map[string]any{
		"handler": map[string]any{"type": "agent", "id": agentID}, "instructions": "Implement it and open a PR.",
	}).Want(http.StatusOK)
	return projectID
}

func TestCreateIssueWorkflowRequiresFlag(t *testing.T) {
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, false)
	testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", map[string]any{
		"name":  "Flag off " + workflowTestSuffix(),
		"steps": statusSteps(),
	})).Want(http.StatusForbidden)
}

func TestCreateIssueWorkflowPlacesFixedStatusesAndValidates(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	name := "Validate " + workflowTestSuffix()
	created := createTestWorkflow(t, name, "done", "in_review")
	keys := make([]string, len(created.Steps))
	for i, s := range created.Steps {
		keys[i] = s.StatusKey
	}
	if got := strings.Join(keys, ","); got != "backlog,todo,in_review,blocked,done,cancelled" {
		t.Fatalf("steps = %s, want the fixed statuses around in_review", got)
	}

	for label, body := range map[string]map[string]any{
		"unknown status": {"name": "x" + workflowTestSuffix(), "steps": statusSteps("no_such_status")},
		"reserved name":  {"name": "Default", "steps": statusSteps()},
		"blank new":      {"name": "z" + workflowTestSuffix(), "steps": []map[string]any{{"new_status": map[string]any{"name": " "}}}},
	} {
		t.Run(label, func(t *testing.T) {
			testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", body)).
				Want(http.StatusBadRequest)
		})
	}
	testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", map[string]any{
		"name": strings.ToUpper(name), "steps": statusSteps(),
	})).Want(http.StatusConflict)
}

func TestCreateIssueWorkflowCreatesNewStatusesOutsideDefault(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	statusName := "Spec " + workflowTestSuffix()[10:]
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	var created IssueWorkflowResponse
	testutil.Call(t, testHandler.CreateIssueWorkflow, workflowRequest("POST", "/api/issue-workflows", map[string]any{
		"name":  "Template " + workflowTestSuffix(),
		"steps": []map[string]any{{"new_status": map[string]any{"name": statusName, "category": "started"}}, {"status_key": "in_review"}},
	})).Want(http.StatusCreated).JSON(&created)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_workflow WHERE id = $1`, created.ID)
		testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName)
	})
	newKey := created.Steps[2].StatusKey
	if issuestatusName := lookupStatusName(t, newKey); issuestatusName != statusName {
		t.Fatalf("step 3 = %q (%q), want the new status", newKey, issuestatusName)
	}

	var list struct {
		Workflows []IssueWorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListIssueWorkflows, workflowRequest("GET", "/api/issue-workflows", nil)).Want(http.StatusOK).JSON(&list)
	if len(list.Workflows) == 0 || !list.Workflows[0].IsDefault {
		t.Fatalf("list = %+v, want Default first", list.Workflows)
	}
	for _, s := range list.Workflows[0].Steps {
		if s.StatusKey == newKey {
			t.Fatalf("a status made for a workflow joined Default: %+v", list.Workflows[0].Steps)
		}
	}
}

func lookupStatusName(t *testing.T, key string) string {
	t.Helper()
	var name string
	dbfx.QueryRow(t, `SELECT name FROM issue_status WHERE workspace_id = $1 AND key = $2`, testWorkspaceID, key).Scan(&name)
	return name
}

func TestDefaultWorkflowIsEditableButNotDeletable(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	var list struct {
		Workflows []IssueWorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListIssueWorkflows, workflowRequest("GET", "/api/issue-workflows", nil)).Want(http.StatusOK).JSON(&list)
	def := list.Workflows[0]
	if !def.IsDefault || def.Name != "Default" {
		t.Fatalf("first workflow = %+v, want Default", def)
	}
	projectID := createWorkflowTestProject(t, "Default usage project")
	issueID := dbfx.Issue(t, "stays on in_review", testutil.Cols{"project_id": projectID, "status": "in_review"})

	var updated IssueWorkflowResponse
	req := withURLParam(workflowRequest("PATCH", "/api/issue-workflows/"+def.ID, map[string]any{
		"name": "Renamed", "steps": statusSteps("in_progress"),
	}), "id", def.ID)
	testutil.Call(t, testHandler.UpdateIssueWorkflow, req).Want(http.StatusOK).JSON(&updated)
	if updated.Name != "Default" || len(updated.Steps) != 6 {
		t.Fatalf("updated Default = %+v, want its name kept and in_review removed", updated)
	}
	// Default accepts every status, so dropping one moves no issue.
	if status, _, _ := issueStatusAndAssignee(t, issueID); status != "in_review" {
		t.Fatalf("editing Default moved an issue to %q", status)
	}
	updateIssueForTest(t, issueID, map[string]any{"status": "in_review"}).Want(http.StatusOK)

	del := withURLParam(workflowRequest("DELETE", "/api/issue-workflows/"+def.ID, nil), "id", def.ID)
	testutil.Call(t, testHandler.DeleteIssueWorkflow, del).Want(http.StatusBadRequest)
}

func TestSetProjectWorkflowMapsOnlyUnlistedStatuses(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	agentID := seededReadyAgentID(t)
	wf := createTestWorkflow(t, "Map "+workflowTestSuffix(), "in_review")
	projectID := createWorkflowTestProject(t, "Workflow map project")
	setProjectHandoff(t, projectID, "in_review", handToAgent(agentID, "")).Want(http.StatusOK)
	keep := dbfx.Issue(t, "stays on todo", testutil.Cols{"project_id": projectID, "status": "todo"})
	moved := dbfx.Issue(t, "leaves in_progress", testutil.Cols{"project_id": projectID, "status": "in_progress"})

	var dry struct {
		Plan workflowMappingPlan `json:"plan"`
	}
	setProjectWorkflow(t, projectID, map[string]any{"workflow_id": wf.ID, "dry_run": true}).Want(http.StatusOK).JSON(&dry)
	if len(dry.Plan.Required) != 1 || dry.Plan.Required[0].StatusKey != "in_progress" || dry.Plan.Required[0].IssueCount != 1 {
		t.Fatalf("plan = %+v, want only in_progress with one issue", dry.Plan)
	}
	if len(dry.Plan.Unchanged) != 1 || dry.Plan.Unchanged[0].StatusKey != "todo" {
		t.Fatalf("unchanged = %+v, want todo kept", dry.Plan.Unchanged)
	}
	if got := dry.Plan.Required[0].SuggestedStatusKey; got != "in_review" {
		t.Fatalf("suggested target = %q, want the same-category step in_review", got)
	}

	setProjectWorkflow(t, projectID, map[string]any{"workflow_id": wf.ID}).Want(http.StatusConflict)
	setProjectWorkflow(t, projectID, map[string]any{
		"workflow_id":    wf.ID,
		"status_mapping": map[string]string{"in_progress": "code_review_nope"},
	}).Want(http.StatusConflict)

	var switched struct {
		Project ProjectResponse `json:"project"`
	}
	setProjectWorkflow(t, projectID, map[string]any{
		"workflow_id":    wf.ID,
		"status_mapping": map[string]string{"in_progress": "in_review"},
	}).Want(http.StatusOK).JSON(&switched)
	if len(switched.Project.WorkflowHandoffs) != 1 || switched.Project.WorkflowHandoffs[0].StatusKey != "in_review" {
		t.Fatalf("handoffs after the switch = %+v, want the in_review handoff kept", switched.Project.WorkflowHandoffs)
	}

	if status, _, _ := issueStatusAndAssignee(t, keep); status != "todo" {
		t.Fatalf("an issue on a listed status moved to %q", status)
	}
	status, assigneeType, _ := issueStatusAndAssignee(t, moved)
	if status != "in_review" {
		t.Fatalf("mapped issue status = %q, want in_review", status)
	}
	// Mapping is administrative: entering a handoff column this way neither
	// reassigns the issue nor starts a run.
	if assigneeType != "" || taskCountFor(t, moved, agentID) != 0 {
		t.Fatalf("a workflow switch handed the issue off (assignee type %q)", assigneeType)
	}

	// Switching back to Default needs no mapping and works with the flag off.
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, false)
	setProjectWorkflow(t, projectID, map[string]any{"workflow_id": nil}).Want(http.StatusOK)
}

func TestUpdateIssueRejectsStatusOutsideNamedWorkflow(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	wf := createTestWorkflow(t, "Reject "+workflowTestSuffix())
	projectID := createWorkflowTestProject(t, "Workflow reject project")
	setProjectWorkflow(t, projectID, map[string]any{"workflow_id": wf.ID}).Want(http.StatusOK)
	issueID := dbfx.Issue(t, "reject in_progress", testutil.Cols{"project_id": projectID, "status": "todo"})

	body := updateIssueForTest(t, issueID, map[string]any{"status": "in_progress"}).Want(http.StatusBadRequest).Map()
	if body["code"] != "status_not_in_workflow" {
		t.Fatalf("code = %v, want status_not_in_workflow", body["code"])
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "backlog, todo, blocked, done, cancelled") {
		t.Fatalf("error %q should list the allowed keys", msg)
	}
	updateIssueForTest(t, issueID, map[string]any{"status": "blocked"}).Want(http.StatusOK)
}

func TestStatusChangeHandsOffOnDefaultProject(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow handoff project", agentID)
	issueID := dbfx.Issue(t, "hand me off", testutil.Cols{"project_id": projectID, "status": "todo"})

	updateIssueForTest(t, issueID, map[string]any{"status": "in_progress"}).Want(http.StatusOK)

	_, assigneeType, assigneeID := issueStatusAndAssignee(t, issueID)
	if assigneeType != "agent" || assigneeID != agentID {
		t.Fatalf("assignee = %s/%s, want the column's agent %s", assigneeType, assigneeID, agentID)
	}
	tasks, err := testHandler.Queries.ListTasksByIssue(context.Background(), util.MustParseUUID(issueID))
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks = %d (%v), want one handoff run", len(tasks), err)
	}
	note := tasks[0].HandoffNote.String
	for _, want := range []string{"Implement it and open a PR.", "This project's workflow — Default (Workflow handoff project)", "Step done      → multica issue status"} {
		if !strings.Contains(note, want) {
			t.Fatalf("handoff note is missing %q:\n%s", want, note)
		}
	}

	// A caller-written note replaces the step's brief.
	back := dbfx.Issue(t, "explicit note", testutil.Cols{"project_id": projectID, "status": "todo"})
	updateIssueForTest(t, back, map[string]any{"status": "in_progress", "handoff_note": "Only the login flow."}).Want(http.StatusOK)
	backTasks, _ := testHandler.Queries.ListTasksByIssue(context.Background(), util.MustParseUUID(back))
	if len(backTasks) != 1 || backTasks[0].HandoffNote.String != "Only the login flow." {
		t.Fatalf("explicit handoff note was not kept: %+v", backTasks)
	}

	// Another project on Default hands nothing off.
	plainProject := createWorkflowTestProject(t, "Workflow no handoff project")
	plain := dbfx.Issue(t, "no handoff", testutil.Cols{"project_id": plainProject, "status": "todo"})
	updateIssueForTest(t, plain, map[string]any{"status": "in_progress"}).Want(http.StatusOK)
	if _, at, _ := issueStatusAndAssignee(t, plain); at != "" {
		t.Fatalf("a project without handoffs reassigned the issue to a %s", at)
	}
}

func TestSetProjectHandoffValidatesAndClears(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := createWorkflowTestProject(t, "Workflow handoff validation project")
	setProjectHandoff(t, projectID, "done", map[string]any{"handler": map[string]any{"type": "project_lead"}}).Want(http.StatusBadRequest)
	setProjectHandoff(t, projectID, "code_review_nope", handToAgent(agentID, "")).Want(http.StatusBadRequest)
	setProjectHandoff(t, projectID, "in_progress", map[string]any{
		"handler": map[string]any{"type": "agent", "id": agentID}, "next_status_key": "in_progress",
	}).Want(http.StatusBadRequest)

	var saved ProjectResponse
	setProjectHandoff(t, projectID, "in_progress", handToAgent(agentID, "Build it")).Want(http.StatusOK).JSON(&saved)
	if len(saved.WorkflowHandoffs) != 1 || saved.WorkflowHandoffs[0].Instructions != "Build it" {
		t.Fatalf("handoffs = %+v", saved.WorkflowHandoffs)
	}
	setProjectHandoff(t, projectID, "in_progress", map[string]any{"handler": map[string]any{"type": "none"}}).Want(http.StatusOK).JSON(&saved)
	if len(saved.WorkflowHandoffs) != 0 {
		t.Fatalf("clearing left handoffs = %+v", saved.WorkflowHandoffs)
	}
	var stored *string
	dbfx.QueryRow(t, `SELECT workflow_handoffs::text FROM project WHERE id = $1`, projectID).Scan(&stored)
	if stored != nil {
		t.Fatalf("cleared handoffs stored %s, want NULL", *stored)
	}
}

// Only workspace admins and the project's lead change its workflow settings.
func TestProjectWorkflowSettingsNeedAdminOrLead(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	suffix := workflowTestSuffix()
	userID := dbfx.User(t, "Workflow member "+suffix, "workflow-member-"+suffix+"@example.com")
	dbfx.Member(t, testWorkspaceID, userID, "member")
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM member WHERE user_id = $1`, userID)
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})
	projectID := createWorkflowTestProject(t, "Workflow permission project")
	asMember := func(r *http.Request) *http.Request {
		r.Header.Set("X-User-ID", userID)
		return r
	}
	put := func() *testutil.Response {
		req := withURLParams(asMember(workflowRequest("PUT", "/api/projects/"+projectID+"/workflow/handoffs/in_progress", handToAgent(agentID, ""))),
			"id", projectID, "status", "in_progress")
		return testutil.Call(t, testHandler.SetProjectWorkflowHandoff, req)
	}
	put().Want(http.StatusForbidden)

	dbfx.Exec(t, `UPDATE project SET lead_type = 'member', lead_id = $1 WHERE id = $2`, userID, projectID)
	put().Want(http.StatusOK)

	// The lead may add a column only for this project, not to Default.
	resetDefaultWorkflow(t)
	statusName := "Lead " + workflowTestSuffix()[10:]
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName)
	})
	addColumn := func(scope string) *testutil.Response {
		req := withURLParam(asMember(workflowRequest("POST", "/api/projects/"+projectID+"/workflow/columns", map[string]any{
			"new_status": map[string]any{"name": statusName}, "scope": scope,
		})), "id", projectID)
		return testutil.Call(t, testHandler.AddProjectWorkflowColumn, req)
	}
	addColumn("workflow").Want(http.StatusForbidden)
	addColumn("project").Want(http.StatusOK)
}

func TestAddColumnOnlyForThisProjectCopiesDefault(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	withFeatureFlag(t, testHandler, featureflags.ProjectWorkflowsV1, true)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow column project", agentID)
	other := createWorkflowTestProject(t, "Workflow column other project")
	statusName := "QA " + workflowTestSuffix()[10:]
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName)
	})
	add := func(body map[string]any) map[string]any {
		req := withURLParam(workflowRequest("POST", "/api/projects/"+projectID+"/workflow/columns", body), "id", projectID)
		return testutil.Call(t, testHandler.AddProjectWorkflowColumn, req).Want(http.StatusOK).Map()
	}
	resp := add(map[string]any{"new_status": map[string]any{"name": statusName, "category": "started"}, "scope": "project", "after_status_key": "in_progress"})
	newKey, _ := resp["status_key"].(string)
	var workflowID *string
	dbfx.QueryRow(t, `SELECT workflow_id::text FROM project WHERE id = $1`, projectID).Scan(&workflowID)
	if workflowID == nil {
		t.Fatal("adding a column only for this project kept it on Default")
	}
	var steps string
	dbfx.QueryRow(t, `SELECT steps::text FROM issue_workflow WHERE id = $1`, *workflowID).Scan(&steps)
	if !strings.Contains(steps, `"in_progress"}, {"status_key": "`+newKey+`"}, {"status_key": "in_review"`) {
		t.Fatalf("own workflow steps = %s, want %s after in_progress", steps, newKey)
	}
	var defaultSteps string
	dbfx.QueryRow(t, `SELECT steps::text FROM issue_workflow WHERE workspace_id = $1 AND is_default`, testWorkspaceID).Scan(&defaultSteps)
	if strings.Contains(defaultSteps, newKey) {
		t.Fatalf("Default gained the project's column: %s", defaultSteps)
	}
	var otherWorkflow *string
	dbfx.QueryRow(t, `SELECT workflow_id::text FROM project WHERE id = $1`, other).Scan(&otherWorkflow)
	if otherWorkflow != nil {
		t.Fatal("another Default project moved off Default")
	}
	// The handoff survives the copy.
	issueID := dbfx.Issue(t, "still handed off", testutil.Cols{"project_id": projectID, "status": "todo"})
	updateIssueForTest(t, issueID, map[string]any{"status": "in_progress"}).Want(http.StatusOK)
	if _, at, aid := issueStatusAndAssignee(t, issueID); at != "agent" || aid != agentID {
		t.Fatalf("assignee after the copy = %s/%s", at, aid)
	}

	// A second column goes into the project's own workflow in place.
	add(map[string]any{"new_status": map[string]any{"name": statusName + " 2"}, "scope": "project"})
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM issue_status WHERE workspace_id = $1 AND name = $2`, testWorkspaceID, statusName+" 2")
	})
	req := withURLParam(workflowRequest("POST", "/api/projects/"+projectID+"/workflow/columns", map[string]any{"status_key": newKey}), "id", projectID)
	testutil.Call(t, testHandler.AddProjectWorkflowColumn, req).Want(http.StatusConflict)
	var again string
	dbfx.QueryRow(t, `SELECT workflow_id::text FROM project WHERE id = $1`, projectID).Scan(&again)
	if again != *workflowID {
		t.Fatal("a column for a project's own workflow made another copy")
	}

	// An admin may add a column to Default for every project using it.
	addOther := withURLParam(workflowRequest("POST", "/api/projects/"+other+"/workflow/columns", map[string]any{"status_key": newKey, "scope": "workflow"}), "id", other)
	testutil.Call(t, testHandler.AddProjectWorkflowColumn, addOther).Want(http.StatusOK)
	dbfx.QueryRow(t, `SELECT steps::text FROM issue_workflow WHERE workspace_id = $1 AND is_default`, testWorkspaceID).Scan(&defaultSteps)
	if !strings.Contains(defaultSteps, newKey) {
		t.Fatalf("Default steps = %s, want %s added", defaultSteps, newKey)
	}
}

func TestExplicitAssigneeWinsOverStepHandler(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow explicit project", agentID)
	issueID := dbfx.Issue(t, "keep my assignee", testutil.Cols{"project_id": projectID, "status": "todo"})

	updateIssueForTest(t, issueID, map[string]any{
		"status": "in_progress", "assignee_type": "member", "assignee_id": testUserID,
	}).Want(http.StatusOK)
	_, assigneeType, assigneeID := issueStatusAndAssignee(t, issueID)
	if assigneeType != "member" || assigneeID != testUserID {
		t.Fatalf("assignee = %s/%s, want the explicit member", assigneeType, assigneeID)
	}
	if n := taskCountFor(t, issueID, agentID); n != 0 {
		t.Fatalf("the step handler ran %d time(s) although the write chose an assignee", n)
	}
}

func TestMoveIntoWorkflowProjectKeepsEquivalentStatusWithoutHandoff(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	agentID := seededReadyAgentID(t)
	wf := createTestWorkflow(t, "Move "+workflowTestSuffix(), "in_review")
	projectID := createWorkflowTestProject(t, "Workflow move project")
	setProjectWorkflow(t, projectID, map[string]any{"workflow_id": wf.ID}).Want(http.StatusOK)
	setProjectHandoff(t, projectID, "in_review", handToAgent(agentID, "")).Want(http.StatusOK)
	issueID := dbfx.Issue(t, "moving in", testutil.Cols{"status": "in_progress"})

	updateIssueForTest(t, issueID, map[string]any{"project_id": projectID}).Want(http.StatusOK)
	status, assigneeType, _ := issueStatusAndAssignee(t, issueID)
	if status != "in_review" {
		t.Fatalf("status after move = %q, want the same-category step in_review", status)
	}
	if assigneeType != "" || taskCountFor(t, issueID, agentID) != 0 {
		t.Fatal("moving an issue into a project must not hand it off")
	}
}

func TestCreateIssueHandsOffItsStartingColumn(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	agentID := seededReadyAgentID(t)
	projectID := createWorkflowTestProject(t, "Workflow create project")
	setProjectHandoff(t, projectID, "todo", map[string]any{
		"handler": map[string]any{"type": "agent", "id": agentID}, "instructions": "Triage it.",
	}).Want(http.StatusOK)

	created := createIssueForTest(t, map[string]any{"title": "starts in todo", "project_id": projectID})
	if created.Status != "todo" {
		t.Fatalf("status = %q, want todo", created.Status)
	}
	if created.AssigneeID == nil || *created.AssigneeID != agentID {
		t.Fatalf("assignee = %v, want the todo column's agent", created.AssigneeID)
	}
	tasks, _ := testHandler.Queries.ListTasksByIssue(context.Background(), util.MustParseUUID(created.ID))
	if len(tasks) != 1 || !strings.Contains(tasks[0].HandoffNote.String, "Triage it.") {
		t.Fatalf("create did not start the column's run with its brief: %+v", tasks)
	}

	wf := createTestWorkflow(t, "Create "+workflowTestSuffix())
	named := createWorkflowTestProject(t, "Workflow create named project")
	setProjectWorkflow(t, named, map[string]any{"workflow_id": wf.ID}).Want(http.StatusOK)
	testutil.Call(t, testHandler.CreateIssue, newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title": "outside the workflow", "project_id": named, "status": "in_progress",
	})).Want(http.StatusBadRequest)
}

func TestArchiveStatusGuardsNamedWorkflowsOnly(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	entry := createTestCustomStatus(t, "wf_guard_"+workflowTestSuffix()[10:], "started")
	createTestWorkflow(t, "Guard "+workflowTestSuffix(), entry.Key)

	req := withURLParam(newRequest("DELETE", "/api/issue-statuses/"+util.UUIDToString(entry.ID), nil), "id", util.UUIDToString(entry.ID))
	body := testutil.Call(t, testHandler.ArchiveIssueStatus, req).Want(http.StatusConflict).Map()
	if body["code"] != "issue_status_in_workflow" {
		t.Fatalf("code = %v, want issue_status_in_workflow", body["code"])
	}

	// A status only Default lists archives and leaves Default.
	loose := createTestCustomStatus(t, "wf_loose_"+workflowTestSuffix()[10:], "started")
	var list struct {
		Workflows []IssueWorkflowResponse `json:"workflows"`
	}
	testutil.Call(t, testHandler.ListIssueWorkflows, workflowRequest("GET", "/api/issue-workflows", nil)).Want(http.StatusOK).JSON(&list)
	def := list.Workflows[0]
	patch := withURLParam(workflowRequest("PATCH", "/api/issue-workflows/"+def.ID, map[string]any{
		"steps": statusSteps("in_progress", loose.Key),
	}), "id", def.ID)
	testutil.Call(t, testHandler.UpdateIssueWorkflow, patch).Want(http.StatusOK)
	archive := withURLParam(newRequest("DELETE", "/api/issue-statuses/"+util.UUIDToString(loose.ID), nil), "id", util.UUIDToString(loose.ID))
	testutil.Call(t, testHandler.ArchiveIssueStatus, archive).Want(http.StatusOK)
	var steps string
	dbfx.QueryRow(t, `SELECT steps::text FROM issue_workflow WHERE id = $1`, def.ID).Scan(&steps)
	if strings.Contains(steps, loose.Key) {
		t.Fatalf("Default still lists the archived status: %s", steps)
	}
}

func TestClaimCarriesProjectWorkflow(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow claim project", agentID)
	issueID := dbfx.Issue(t, "claim context", testutil.Cols{"project_id": projectID, "status": "in_progress"})

	issue, err := testHandler.Queries.GetIssue(context.Background(), util.MustParseUUID(issueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}
	got := testHandler.claimProjectWorkflow(context.Background(), issue)
	if got == nil || got.CurrentStatusKey != "in_progress" || len(got.Steps) != 7 {
		t.Fatalf("claim workflow = %+v", got)
	}
	current := got.Steps[2]
	if current.Handler == "" || current.Handler == "agent" || current.Instructions == "" || current.NextStatusKey != "in_review" {
		t.Fatalf("current step = %+v, want a named handler, its instructions and the next column", current)
	}
	if got.Steps[3].Instructions != "" {
		t.Fatal("only the current step's instructions ride the claim")
	}

	plain := dbfx.Issue(t, "no workflow", testutil.Cols{"status": "todo"})
	plainIssue, _ := testHandler.Queries.GetIssue(context.Background(), util.MustParseUUID(plain))
	if testHandler.claimProjectWorkflow(context.Background(), plainIssue) != nil {
		t.Fatal("an issue outside a project must not carry a workflow")
	}
	quietProject := createWorkflowTestProject(t, "Workflow quiet project")
	quiet := dbfx.Issue(t, "no handoffs", testutil.Cols{"project_id": quietProject, "status": "todo"})
	quietIssue, _ := testHandler.Queries.GetIssue(context.Background(), util.MustParseUUID(quiet))
	if testHandler.claimProjectWorkflow(context.Background(), quietIssue) != nil {
		t.Fatal("a Default project without handoffs must not carry a workflow")
	}
}

func TestPreviewWorkflowHandoffNamesHandlerRunsAndBrief(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow preview project", agentID)
	issueID := dbfx.Issue(t, "preview me", testutil.Cols{"project_id": projectID, "status": "todo"})

	call := func(status string) *testutil.Response {
		req := withURLParam(newRequest("GET", "/api/issues/"+issueID+"/workflow-handoff?status="+status, nil), "id", issueID)
		return testutil.Call(t, testHandler.PreviewWorkflowHandoff, req)
	}
	var got WorkflowHandoffPreviewResponse
	call("in_progress").Want(http.StatusOK).JSON(&got)
	if !got.Handoff || got.HandlerType != "agent" || got.HandlerID != agentID || got.WorkflowName != "Default" {
		t.Fatalf("preview = %+v, want a handoff to the column's agent", got)
	}
	if !strings.Contains(got.Brief, "Implement it and open a PR.") {
		t.Fatalf("preview brief is missing the step instructions:\n%s", got.Brief)
	}
	if status, _, _ := issueStatusAndAssignee(t, issueID); status != "todo" {
		t.Fatalf("a preview moved the issue to %q", status)
	}

	var manual WorkflowHandoffPreviewResponse
	call("done").Want(http.StatusOK).JSON(&manual)
	if manual.Handoff {
		t.Fatalf("a column without a handoff previewed one: %+v", manual)
	}
}

func TestPreviewProjectWorkflowBriefUsesTheDraft(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := createWorkflowTestProject(t, "Workflow brief project")
	var got struct {
		Brief string `json:"brief"`
	}
	preview := func(body map[string]any) *testutil.Response {
		req := withURLParam(workflowRequest("POST", "/api/projects/"+projectID+"/workflow/brief", body), "id", projectID)
		return testutil.Call(t, testHandler.PreviewProjectWorkflowBrief, req)
	}
	preview(map[string]any{
		"status_key": "in_progress", "handler": map[string]any{"type": "agent", "id": agentID}, "instructions": "Draft step.",
	}).Want(http.StatusOK).JSON(&got)
	for _, want := range []string{"Default (Workflow brief project)", "Draft step.", "← current", "in_review\nCan't proceed"} {
		if !strings.Contains(got.Brief, want) {
			t.Fatalf("draft brief is missing %q:\n%s", want, got.Brief)
		}
	}
	preview(map[string]any{"status_key": "no_such_column"}).Want(http.StatusBadRequest)
}

// agentUpdateIssue changes an issue as the agent running taskID, the way a
// task token reaches the handler.
func agentUpdateIssue(t *testing.T, issueID, agentID, taskID string, body map[string]any) *testutil.Response {
	t.Helper()
	req := withURLParam(newRequest("PUT", "/api/issues/"+issueID, body), "id", issueID)
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)
	return testutil.Call(t, testHandler.UpdateIssue, req)
}

func taskWorkflowStep(t *testing.T, taskID string) string {
	t.Helper()
	var step *string
	dbfx.QueryRow(t, `SELECT workflow_step FROM agent_task_queue WHERE id = $1`, taskID).Scan(&step)
	if step == nil {
		return ""
	}
	return *step
}

// The validation report: an agent handling two adjacent columns moves the
// issue into the second from its own run. Entering the step is new work, so a
// run for it is queued although the agent is still running.
func TestSameAgentNextStepQueuesARun(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow same agent project", agentID)
	setProjectHandoff(t, projectID, "in_review", handToAgent(agentID, "Review your own PR.")).Want(http.StatusOK)
	issueID := dbfx.Issue(t, "same agent twice", testutil.Cols{"project_id": projectID, "status": "todo"})

	updateIssueForTest(t, issueID, map[string]any{"status": "in_progress"}).Want(http.StatusOK)
	var taskID string
	dbfx.QueryRow(t, `SELECT id::text FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`, issueID, agentID).Scan(&taskID)
	dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'running', started_at = now() WHERE id = $1`, taskID)

	agentUpdateIssue(t, issueID, agentID, taskID, map[string]any{"status": "in_review"}).Want(http.StatusOK)
	var queued int
	var note string
	dbfx.QueryRow(t, `SELECT count(*), COALESCE(max(handoff_note), '') FROM agent_task_queue
		WHERE issue_id = $1 AND agent_id = $2 AND status = 'queued'`, issueID, agentID).Scan(&queued, &note)
	if queued != 1 || !strings.Contains(note, "Review your own PR.") {
		t.Fatalf("queued runs for the next step = %d (note %q), want one with the step's brief", queued, note)
	}
}

// A run works on the step the issue was at when it was queued. Once someone
// else moves the issue, the run's status changes are refused — they were
// decided for a step the issue has left — and the refusal names the move.
func TestAgentStatusChangeRefusedAfterIssueMoved(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	projectID := deliveryProject(t, "Workflow stale step project", agentID)
	issueID := dbfx.Issue(t, "stale step", testutil.Cols{"project_id": projectID, "status": "todo"})

	updateIssueForTest(t, issueID, map[string]any{"status": "in_progress"}).Want(http.StatusOK)
	var taskID string
	dbfx.QueryRow(t, `SELECT id::text FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`, issueID, agentID).Scan(&taskID)
	if got := taskWorkflowStep(t, taskID); got != "in_progress" {
		t.Fatalf("handoff run step = %q, want in_progress", got)
	}

	// The run's own move is allowed and carries its step along.
	agentUpdateIssue(t, issueID, agentID, taskID, map[string]any{"status": "in_review"}).Want(http.StatusOK)
	if got := taskWorkflowStep(t, taskID); got != "in_review" {
		t.Fatalf("step after the run's own move = %q, want in_review", got)
	}

	// A member parks the issue while the run is still going. The activity row
	// is what the server's listener records for that move; handler tests run
	// without the listeners.
	updateIssueForTest(t, issueID, map[string]any{"status": "blocked"}).Want(http.StatusOK)
	dbfx.Exec(t, `INSERT INTO activity_log (workspace_id, issue_id, actor_type, actor_id, action, details)
		VALUES ($1, $2, 'member', $3, 'status_changed', '{"from":"in_review","to":"blocked"}')`, testWorkspaceID, issueID, testUserID)

	body := agentUpdateIssue(t, issueID, agentID, taskID, map[string]any{"status": "done"}).Want(http.StatusConflict).Map()
	if body["code"] != "workflow_step_moved" || body["step"] != "in_review" || body["current_status"] != "blocked" {
		t.Fatalf("refusal = %v", body)
	}
	var memberName string
	dbfx.QueryRow(t, `SELECT name FROM "user" WHERE id = $1`, testUserID).Scan(&memberName)
	msg, _ := body["error"].(string)
	for _, want := range []string{memberName + " moved it to", `"blocked"`, "not applied"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("refusal %q is missing %q", msg, want)
		}
	}
	if status, _, _ := issueStatusAndAssignee(t, issueID); status != "blocked" {
		t.Fatalf("status = %q, the refused change must not apply", status)
	}

	// Anything but a status change still goes through.
	agentUpdateIssue(t, issueID, agentID, taskID, map[string]any{"title": "stale step, noted"}).Want(http.StatusOK)
	agentUpdateIssue(t, issueID, agentID, taskID, map[string]any{"status": "blocked"}).Want(http.StatusOK)

	// A run queued after the move works on the new step.
	var runtimeID string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID)
	fresh := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issueID, "runtime_id": runtimeID, "status": "running", "started_at": time.Now(), "workflow_step": "blocked",
	})
	agentUpdateIssue(t, issueID, agentID, fresh, map[string]any{"status": "in_review"}).Want(http.StatusOK)
}

// A handoff away from a squad offers to stop — and stops — the runs made on
// the squad's behalf, recording who stopped them.
func TestHandoffStopsPreviousSquadRuns(t *testing.T) {
	seedTestCatalog(t)
	agentID := seededReadyAgentID(t)
	squadID := dbfx.Squad(t, "Workflow review squad "+workflowTestSuffix(), agentID)
	projectID := createWorkflowTestProject(t, "Workflow squad stop project")
	setProjectHandoff(t, projectID, "in_progress", map[string]any{"handler": map[string]any{"type": "member", "id": testUserID}}).Want(http.StatusOK)
	setProjectHandoff(t, projectID, "in_review", map[string]any{"handler": map[string]any{"type": "squad", "id": squadID}}).Want(http.StatusOK)
	issueID := dbfx.Issue(t, "squad reviewing", testutil.Cols{
		"project_id": projectID, "status": "in_review", "assignee_type": "squad", "assignee_id": squadID,
	})
	var runtimeID string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID)
	running := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issueID, "squad_id": squadID, "runtime_id": runtimeID, "status": "running", "started_at": time.Now(),
	})

	var preview WorkflowHandoffPreviewResponse
	req := withURLParam(newRequest("GET", "/api/issues/"+issueID+"/workflow-handoff?status=in_progress", nil), "id", issueID)
	testutil.Call(t, testHandler.PreviewWorkflowHandoff, req).Want(http.StatusOK).JSON(&preview)
	if len(preview.PreviousRuns) != 1 || preview.PreviousRuns[0].TaskID != running {
		t.Fatalf("preview runs = %+v, want the squad's run", preview.PreviousRuns)
	}

	updateIssueForTest(t, issueID, map[string]any{"status": "in_progress", "stop_previous_assignee_runs": true}).Want(http.StatusOK)
	var status string
	var stoppedBy *string
	dbfx.QueryRow(t, `SELECT status, cancelled_by_name FROM agent_task_queue WHERE id = $1`, running).Scan(&status, &stoppedBy)
	var memberName string
	dbfx.QueryRow(t, `SELECT name FROM "user" WHERE id = $1`, testUserID).Scan(&memberName)
	if status != "cancelled" || stoppedBy == nil || *stoppedBy != memberName {
		t.Fatalf("squad run = %s stopped by %v, want cancelled by %s", status, stoppedBy, memberName)
	}
}

// Remapping an issue into a done status on a workflow switch ends its wakeups,
// as any status write into done does.
func TestWorkflowSwitchIntoDoneEndsWakeups(t *testing.T) {
	seedTestCatalog(t)
	resetDefaultWorkflow(t)
	agentID := seededReadyAgentID(t)
	projectID := createWorkflowTestProject(t, "Workflow switch wakeups project")
	issueID := dbfx.Issue(t, "wakeups end with the issue", testutil.Cols{"project_id": projectID, "status": "in_review"})
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	wakeup, err := svc.Create(context.Background(), parseUUID(issueID), parseUUID(testUserID), pgtype.UUID{},
		service.WakeupInput{AgentID: agentID, Kind: "at", AfterSeconds: 600, Instruction: "check the PR"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue_wakeup WHERE issue_id = $1`, issueID) })
	var runtimeID string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id = $1`, agentID).Scan(&runtimeID)
	pending := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issueID, "runtime_id": runtimeID, "status": "queued",
		"context": testutil.Raw("jsonb_build_object('wakeup_id', '" + uuidToString(wakeup.ID) + "')"),
	})

	wf := createTestWorkflow(t, "Wakeup switch "+workflowTestSuffix())
	setProjectWorkflow(t, projectID, map[string]any{
		"workflow_id": wf.ID, "status_mapping": map[string]string{"in_review": "done"},
	}).Want(http.StatusOK)

	var enabled bool
	var taskStatus string
	dbfx.QueryRow(t, `SELECT enabled FROM issue_wakeup WHERE id = $1`, uuidToString(wakeup.ID)).Scan(&enabled)
	dbfx.QueryRow(t, `SELECT status FROM agent_task_queue WHERE id = $1`, pending).Scan(&taskStatus)
	if enabled || taskStatus != "cancelled" {
		t.Fatalf("after the switch into done: wakeup enabled=%v, pending wakeup run %s", enabled, taskStatus)
	}
}

// A write that hands an issue to an agent delivers the change to that agent
// as its run, so the agent's event wakeups skip it; other agents' wakeups
// still capture it. Holds for workflow handoffs and plain assignment alike.
func TestHandoffDoesNotAlsoWakeTheHandler(t *testing.T) {
	seedTestCatalog(t)
	handler := seededReadyAgentID(t)
	var runtimeID string
	dbfx.QueryRow(t, `SELECT runtime_id::text FROM agent WHERE id = $1`, handler).Scan(&runtimeID)
	watcher := dbfx.Agent(t, "Workflow wakeup watcher "+workflowTestSuffix(), runtimeID)
	projectID := deliveryProject(t, "Workflow wakeup dedupe project", handler)
	svc := service.IssueWakeupService{Tasks: testHandler.TaskService}
	subscribe := func(issueID, agentID string) string {
		t.Helper()
		w, err := svc.Create(context.Background(), parseUUID(issueID), parseUUID(testUserID), pgtype.UUID{}, service.WakeupInput{
			AgentID: agentID, Kind: "event", EventTypes: []string{"issue.status_changed", "issue.assignee_changed"}, Instruction: "look again",
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			testPool.Exec(context.Background(), `DELETE FROM issue_wakeup_receipt WHERE wakeup_id = $1`, w.ID)
		})
		return uuidToString(w.ID)
	}
	pending := func(wakeupID string) int {
		t.Helper()
		var n int
		dbfx.QueryRow(t, `SELECT count(*) FROM issue_wakeup_receipt WHERE wakeup_id = $1 AND processed_at IS NULL`, wakeupID).Scan(&n)
		return n
	}

	handedOff := dbfx.Issue(t, "handed off", testutil.Cols{"project_id": projectID, "status": "todo"})
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue_wakeup WHERE issue_id = $1`, handedOff) })
	handlerWakeup, watcherWakeup := subscribe(handedOff, handler), subscribe(handedOff, watcher)
	updateIssueForTest(t, handedOff, map[string]any{"status": "in_progress"}).Want(http.StatusOK)
	if n := pending(handlerWakeup); n != 0 {
		t.Fatalf("the handoff also woke its handler: %d receipt(s)", n)
	}
	if n := pending(watcherWakeup); n == 0 {
		t.Fatal("another agent's wakeup missed the handoff")
	}

	assigned := dbfx.Issue(t, "assigned", testutil.Cols{"status": "todo"})
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue_wakeup WHERE issue_id = $1`, assigned) })
	handlerWakeup, watcherWakeup = subscribe(assigned, handler), subscribe(assigned, watcher)
	updateIssueForTest(t, assigned, map[string]any{"assignee_type": "agent", "assignee_id": handler}).Want(http.StatusOK)
	if n := pending(handlerWakeup); n != 0 {
		t.Fatalf("assignment also woke the assignee: %d receipt(s)", n)
	}
	if n := pending(watcherWakeup); n == 0 {
		t.Fatal("another agent's wakeup missed the assignment")
	}
}
