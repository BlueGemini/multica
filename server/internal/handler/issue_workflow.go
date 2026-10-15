package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Project workflow API (MUL-7420).
//
// Reading workflows is open to any member: every client needs them to render
// a project's board and to filter status choices. A project's own workflow
// settings — which workflow it uses, who each column hands off to, adding a
// column only for it — are open to workspace owners/admins and to the
// project's lead. Changing the Default workflow, a workflow several projects
// share, or deleting a workflow is owner/admin only.

// requireProjectWorkflowsV1 gates adopting workflows behind the
// project_workflows_v1 flag. Reads, edits of existing workflows and switching
// a project back to Default stay open, so turning the flag off never strands
// a project on a workflow nobody can maintain.
func (h *Handler) requireProjectWorkflowsV1(w http.ResponseWriter, r *http.Request) bool {
	if featureflags.ProjectWorkflowsV1Enabled(r.Context(), h.FeatureFlags) {
		return true
	}
	writeFeatureDisabled(w, "project_workflows_disabled", "Project workflows are not enabled")
	return false
}

func isWorkspaceAdmin(member db.Member) bool {
	return roleAllowed(member.Role, "owner", "admin")
}

// canManageProjectWorkflow reports whether member may change a project's own
// workflow settings: owners and admins, and the member who leads the project.
func canManageProjectWorkflow(member db.Member, project db.Project) bool {
	if isWorkspaceAdmin(member) {
		return true
	}
	return project.LeadType.Valid && project.LeadType.String == "member" && project.LeadID == member.UserID
}

type IssueWorkflowHandlerPayload struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

// IssueWorkflowStepPayload is one status of a workflow, in board order.
type IssueWorkflowStepPayload struct {
	StatusKey string `json:"status_key"`
}

// IssueWorkflowHandoffPayload is what a project does when an issue enters
// one of its columns.
type IssueWorkflowHandoffPayload struct {
	StatusKey     string                      `json:"status_key"`
	Handler       IssueWorkflowHandlerPayload `json:"handler"`
	Instructions  string                      `json:"instructions"`
	NextStatusKey string                      `json:"next_status_key,omitempty"`
	BackStatusKey string                      `json:"back_status_key,omitempty"`
}

type IssueWorkflowResponse struct {
	ID          string                     `json:"id"`
	WorkspaceID string                     `json:"workspace_id"`
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	IsDefault   bool                       `json:"is_default"`
	Steps       []IssueWorkflowStepPayload `json:"steps"`
	ProjectIDs  []string                   `json:"project_ids"`
	CreatedAt   string                     `json:"created_at"`
	UpdatedAt   string                     `json:"updated_at"`
}

// StatusMappingRequirement names a status some issues are on that the target
// workflow does not list. SuggestedStatusKey is the server's default choice.
type StatusMappingRequirement struct {
	StatusKey          string `json:"status_key"`
	IssueCount         int64  `json:"issue_count"`
	SuggestedStatusKey string `json:"suggested_status_key"`
}

// StatusIssueCount is a status some issues are on that the target workflow
// also lists, so they keep it.
type StatusIssueCount struct {
	StatusKey  string `json:"status_key"`
	IssueCount int64  `json:"issue_count"`
}

type workflowMappingPlan struct {
	Required       []StatusMappingRequirement `json:"required"`
	Unchanged      []StatusIssueCount         `json:"unchanged"`
	TotalIssues    int64                      `json:"total_issues"`
	AffectedIssues int64                      `json:"affected_issues"`
}

func handoffsToPayload(steps []issueworkflow.Step) []IssueWorkflowHandoffPayload {
	out := make([]IssueWorkflowHandoffPayload, 0, len(steps))
	for _, s := range steps {
		out = append(out, IssueWorkflowHandoffPayload{
			StatusKey:     s.StatusKey,
			Handler:       IssueWorkflowHandlerPayload{Type: s.Handler.Type, ID: s.Handler.ID},
			Instructions:  s.Instructions,
			NextStatusKey: s.NextStatusKey,
			BackStatusKey: s.BackStatusKey,
		})
	}
	return out
}

func payloadToHandoff(statusKey string, in IssueWorkflowHandoffPayload) issueworkflow.Step {
	return issueworkflow.Step{
		StatusKey:     statusKey,
		Handler:       issueworkflow.Handler{Type: in.Handler.Type, ID: in.Handler.ID},
		Instructions:  in.Instructions,
		NextStatusKey: in.NextStatusKey,
		BackStatusKey: in.BackStatusKey,
	}
}

// projectHandoffsPayload is a project's stored handoffs for its response. A
// malformed column reads as none rather than failing the project read.
func projectHandoffsPayload(p db.Project) []IssueWorkflowHandoffPayload {
	steps, err := issueworkflow.DecodeHandoffs(p.WorkflowHandoffs)
	if err != nil {
		return []IssueWorkflowHandoffPayload{}
	}
	return handoffsToPayload(steps)
}

func issueWorkflowToResponse(row db.IssueWorkflow, def issueworkflow.Definition, projectIDs []string) IssueWorkflowResponse {
	if projectIDs == nil {
		projectIDs = []string{}
	}
	steps := make([]IssueWorkflowStepPayload, len(def.Steps))
	for i, s := range def.Steps {
		steps[i] = IssueWorkflowStepPayload{StatusKey: s.StatusKey}
	}
	return IssueWorkflowResponse{
		ID:          uuidToString(row.ID),
		WorkspaceID: uuidToString(row.WorkspaceID),
		Name:        row.Name,
		Description: row.Description,
		IsDefault:   row.IsDefault,
		Steps:       steps,
		ProjectIDs:  projectIDs,
		CreatedAt:   timestampToString(row.CreatedAt),
		UpdatedAt:   timestampToString(row.UpdatedAt),
	}
}

// projectIDsByWorkflow groups the workspace's projects by the workflow row
// they use, so a list response can say where each workflow applies. Projects
// without a workflow, or pointing at a deleted one, count for Default.
func (h *Handler) projectIDsByWorkflow(ctx context.Context, wsUUID pgtype.UUID, rows []db.IssueWorkflow) (map[string][]string, error) {
	projects, err := h.Queries.ListProjects(ctx, db.ListProjectsParams{WorkspaceID: wsUUID})
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	defaultID := ""
	for _, row := range rows {
		id := uuidToString(row.ID)
		known[id] = true
		if row.IsDefault {
			defaultID = id
		}
	}
	out := map[string][]string{}
	for _, p := range projects {
		key := uuidToString(p.WorkflowID)
		if !p.WorkflowID.Valid || !known[key] {
			key = defaultID
		}
		if key != "" {
			out[key] = append(out[key], uuidToString(p.ID))
		}
	}
	return out, nil
}

// workflowStatusCatalog loads the workspace catalog keyed by status key,
// including archived rows so validation can say why a key is unusable.
func (h *Handler) workflowStatusCatalog(ctx context.Context, q *db.Queries, wsUUID pgtype.UUID) (map[string]issueworkflow.CatalogEntry, error) {
	if err := issuestatus.Ensure(ctx, q, wsUUID); err != nil {
		return nil, err
	}
	rows, err := q.ListIssueStatusEntries(ctx, db.ListIssueStatusEntriesParams{WorkspaceID: wsUUID, IncludeArchived: true})
	if err != nil {
		return nil, err
	}
	out := make(map[string]issueworkflow.CatalogEntry, len(rows))
	for _, row := range rows {
		// The lifecycle category, not the legacy wire value: a switch maps
		// in_progress onto in_review because both are "started".
		category, _ := issuestatus.ParseCategory(row.Category)
		out[row.Key] = issueworkflow.CatalogEntry{
			Key:      row.Key,
			Name:     row.Name,
			Category: category,
			Archived: row.ArchivedAt.Valid,
		}
	}
	return out, nil
}

func (h *Handler) ListIssueWorkflows(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	// Default is stored the first time workflows are read with the feature
	// on, so every client sees the same Default from then on.
	if featureflags.ProjectWorkflowsV1Enabled(r.Context(), h.FeatureFlags) {
		if _, err := issueworkflow.EnsureDefault(r.Context(), h.Queries, wsUUID); err != nil {
			slog.Warn("ListIssueWorkflows ensure default failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to list workflows")
			return
		}
	}
	rows, err := h.Queries.ListIssueWorkflows(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ListIssueWorkflows failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflows")
		return
	}
	byWorkflow, err := h.projectIDsByWorkflow(r.Context(), wsUUID, rows)
	if err != nil {
		slog.Warn("ListIssueWorkflows projects failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list workflows")
		return
	}
	resp := make([]IssueWorkflowResponse, 0, len(rows))
	for _, row := range rows {
		def, err := issueworkflow.Decode(row)
		if err != nil {
			slog.Warn("ListIssueWorkflows decode failed", append(logger.RequestAttrs(r), "workflow_id", uuidToString(row.ID), "error", err)...)
			continue
		}
		resp = append(resp, issueWorkflowToResponse(row, def, byWorkflow[uuidToString(row.ID)]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": resp, "total": len(resp)})
}

func (h *Handler) GetIssueWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	row, err := h.Queries.GetIssueWorkflow(r.Context(), db.GetIssueWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	h.writeIssueWorkflow(w, r, http.StatusOK, row)
}

func (h *Handler) writeIssueWorkflow(w http.ResponseWriter, r *http.Request, status int, row db.IssueWorkflow) {
	writeJSON(w, status, h.issueWorkflowResponse(r.Context(), row))
}

func (h *Handler) issueWorkflowResponse(ctx context.Context, row db.IssueWorkflow) IssueWorkflowResponse {
	def, err := issueworkflow.Decode(row)
	if err != nil {
		def = issueworkflow.Definition{}
	}
	rows, err := h.Queries.ListIssueWorkflows(ctx, row.WorkspaceID)
	if err != nil {
		rows = []db.IssueWorkflow{row}
	}
	byWorkflow, err := h.projectIDsByWorkflow(ctx, row.WorkspaceID, rows)
	if err != nil {
		byWorkflow = map[string][]string{}
	}
	return issueWorkflowToResponse(row, def, byWorkflow[uuidToString(row.ID)])
}

// NewWorkflowStatus creates a catalog status as part of a workflow write, so
// a project lead can add a column without the status settings page.
type NewWorkflowStatus struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	Color    string `json:"color"`
}

// IssueWorkflowStepInput names a step by an existing status key or by a
// status to create.
type IssueWorkflowStepInput struct {
	StatusKey string             `json:"status_key,omitempty"`
	NewStatus *NewWorkflowStatus `json:"new_status,omitempty"`
}

type IssueWorkflowWriteRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	// Steps are the workflow's own statuses, in order. The fixed statuses
	// (backlog, todo, blocked, done, cancelled) are placed around them and
	// may be omitted.
	Steps *[]IssueWorkflowStepInput `json:"steps"`
	// StatusMapping moves issues off statuses an edit removes, keyed by the
	// removed status. Required for every removed status that issues of the
	// workflow's projects still use.
	StatusMapping map[string]string `json:"status_mapping,omitempty"`
	// DryRun validates the edit and returns the mapping plan without writing.
	DryRun bool `json:"dry_run,omitempty"`
}

var newStatusDefaultColor = map[string]string{
	"unstarted": "#94a3b8",
	"started":   "#3b82f6",
	"done":      "#22c55e",
	"closed":    "#64748b",
}

// resolveStepInputs turns step inputs into status keys, creating the new
// statuses they name. The caller holds the exclusive catalog lock. A
// non-empty message is a caller error.
func resolveStepInputs(ctx context.Context, qtx *db.Queries, wsUUID pgtype.UUID, inputs []IssueWorkflowStepInput) ([]string, []db.IssueStatus, string, error) {
	keys := make([]string, 0, len(inputs))
	var created []db.IssueStatus
	for _, in := range inputs {
		if in.NewStatus == nil {
			keys = append(keys, strings.TrimSpace(in.StatusKey))
			continue
		}
		entry, msg, err := createWorkflowStatus(ctx, qtx, wsUUID, *in.NewStatus)
		if msg != "" || err != nil {
			return nil, nil, msg, err
		}
		created = append(created, entry)
		keys = append(keys, entry.Key)
	}
	return keys, created, "", nil
}

func createWorkflowStatus(ctx context.Context, qtx *db.Queries, wsUUID pgtype.UUID, in NewWorkflowStatus) (db.IssueStatus, string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 64 {
		return db.IssueStatus{}, "status name must be 1-64 characters", nil
	}
	category, ok := issuestatus.ParseCategory(in.Category)
	if !ok {
		category = "started"
	}
	color := newStatusDefaultColor[category]
	if strings.TrimSpace(in.Color) != "" {
		c, err := normalizeColor(in.Color)
		if err != nil {
			return db.IssueStatus{}, err.Error(), nil
		}
		color = c
	}
	// A status with this name already exists: reuse it instead of failing,
	// so the same template applied twice lands on the same statuses.
	entries, err := qtx.ListIssueStatusEntries(ctx, db.ListIssueStatusEntriesParams{WorkspaceID: wsUUID, IncludeArchived: false})
	if err != nil {
		return db.IssueStatus{}, "", err
	}
	for _, e := range entries {
		if strings.EqualFold(e.Name, name) {
			return e, "", nil
		}
	}
	entry, msg, err := createIssueStatusEntryLocked(ctx, qtx, wsUUID, category, db.CreateIssueStatusEntryParams{
		WorkspaceID: wsUUID,
		Name:        name,
		Category:    category,
		Color:       color,
	})
	if err != nil && isUniqueViolation(err) {
		return db.IssueStatus{}, fmt.Sprintf("a status named %q already exists", name), nil
	}
	return entry, msg, err
}

// validateHandoffHandler checks that a concrete handler exists in the
// workspace and that the caller may hand work to it — the same gate an
// assignment passes.
func (h *Handler) validateHandoffHandler(ctx context.Context, r *http.Request, workspaceID string, s issueworkflow.Step) (int, string) {
	switch s.Handler.Type {
	case issueworkflow.HandlerAgent, issueworkflow.HandlerSquad, issueworkflow.HandlerMember:
		id, err := parseUUIDString(s.Handler.ID)
		if err != nil {
			return http.StatusBadRequest, "invalid handler id"
		}
		return h.validateAssigneePair(ctx, r, workspaceID, pgtype.Text{String: s.Handler.Type, Valid: true}, id)
	}
	return 0, ""
}

func parseUUIDString(s string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(s); err != nil || !id.Valid {
		return pgtype.UUID{}, errors.New("invalid uuid")
	}
	return id, nil
}

func (h *Handler) CreateIssueWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	if !h.requireProjectWorkflowsV1(w, r) {
		return
	}
	var req IssueWorkflowWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !isWorkspaceAdmin(member) {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	}
	var name, description string
	if req.Name != nil {
		name = *req.Name
	}
	if req.Description != nil {
		description = *req.Description
	}
	var inputs []IssueWorkflowStepInput
	if req.Steps != nil {
		inputs = *req.Steps
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockIssueStatusCatalog(ctx, wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	// Store Default before creating statuses for this workflow, so they
	// never join Default's snapshot.
	if _, err := issueworkflow.EnsureDefault(ctx, qtx, wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	keys, createdStatuses, msg, err := resolveStepInputs(ctx, qtx, wsUUID, inputs)
	if msg != "" {
		writeErrorCode(w, http.StatusBadRequest, "invalid_workflow", msg)
		return
	}
	if err != nil {
		slog.Warn("CreateIssueWorkflow statuses failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	name, description, keys = issueworkflow.Normalize(name, description, keys)
	catalog, err := h.workflowStatusCatalog(ctx, qtx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue statuses")
		return
	}
	if err := issueworkflow.Validate(name, description, keys, false, catalog); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "invalid_workflow", err.Error())
		return
	}
	raw, err := issueworkflow.EncodeKeys(keys)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	row, err := qtx.CreateIssueWorkflow(ctx, db.CreateIssueWorkflowParams{
		WorkspaceID:      wsUUID,
		Name:             name,
		Description:      description,
		InitialStatusKey: issueworkflow.StartStatus,
		Steps:            raw,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeErrorCode(w, http.StatusConflict, "workflow_name_taken", "a workflow with this name already exists")
			return
		}
		slog.Warn("CreateIssueWorkflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	if len(createdStatuses) > 0 {
		h.publishIssueStatusChanged(workspaceID, member, "created")
	}
	h.publishIssueWorkflowChanged(workspaceID, member, "created")
	h.writeIssueWorkflow(w, r, http.StatusCreated, row)
}

// mappingPlan computes which statuses issues of projectIDs are on that
// allowed() rejects, with a suggested target for each.
func mappingPlan(counts []db.CountProjectIssuesByStatusRow, allowed func(string) bool, suggest func(string) string) workflowMappingPlan {
	plan := workflowMappingPlan{Required: []StatusMappingRequirement{}, Unchanged: []StatusIssueCount{}}
	for _, c := range counts {
		plan.TotalIssues += c.IssueCount
		if allowed(c.Status) {
			plan.Unchanged = append(plan.Unchanged, StatusIssueCount{StatusKey: c.Status, IssueCount: c.IssueCount})
			continue
		}
		plan.AffectedIssues += c.IssueCount
		plan.Required = append(plan.Required, StatusMappingRequirement{
			StatusKey:          c.Status,
			IssueCount:         c.IssueCount,
			SuggestedStatusKey: suggest(c.Status),
		})
	}
	sort.Slice(plan.Required, func(i, j int) bool { return plan.Required[i].StatusKey < plan.Required[j].StatusKey })
	return plan
}

// checkMapping verifies a mapping covers every required status with a target
// the destination accepts. It returns the first problem as a message.
func checkMapping(plan workflowMappingPlan, mapping map[string]string, targetAllowed func(string) bool) string {
	for _, req := range plan.Required {
		target, ok := mapping[req.StatusKey]
		if !ok || target == "" {
			return fmt.Sprintf("choose a destination status for the %d issue(s) on %q", req.IssueCount, req.StatusKey)
		}
		if !targetAllowed(target) {
			return fmt.Sprintf("destination status %q for %q is not part of the target workflow", target, req.StatusKey)
		}
	}
	return ""
}

func writeMappingRequired(w http.ResponseWriter, plan workflowMappingPlan, msg string) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": msg,
		"code":  "workflow_status_mapping_required",
		"plan":  plan,
	})
}

// remapIssues applies a validated mapping inside the caller's transaction.
// An issue it moves into a done or closed status ends its wakeups, as any
// status write does; the returned runs are for the caller's post-commit
// broadcast.
func remapIssues(ctx context.Context, qtx *db.Queries, wsUUID pgtype.UUID, projectIDs []pgtype.UUID, plan workflowMappingPlan, mapping map[string]string) ([]db.Issue, []db.AgentTaskQueue, error) {
	var changed []db.Issue
	var cancelled []db.AgentTaskQueue
	for _, req := range plan.Required {
		rows, err := qtx.RemapProjectIssueStatus(ctx, db.RemapProjectIssueStatusParams{
			WorkspaceID: wsUUID,
			ProjectIds:  projectIDs,
			FromStatus:  req.StatusKey,
			ToStatus:    mapping[req.StatusKey],
		})
		if err != nil {
			return nil, nil, err
		}
		for _, issue := range rows {
			stopped, err := service.StopClosedIssueWakeups(ctx, qtx, issue)
			if err != nil {
				return nil, nil, err
			}
			cancelled = append(cancelled, stopped...)
		}
		changed = append(changed, rows...)
	}
	return changed, cancelled, nil
}

// canEditWorkflowStatuses reports whether member may change which statuses a
// workflow lists: owners and admins always; a project lead only for a named
// workflow that serves nothing but projects they lead.
func canEditWorkflowStatuses(member db.Member, row db.IssueWorkflow, projects []db.Project) bool {
	if isWorkspaceAdmin(member) {
		return true
	}
	if row.IsDefault || len(projects) == 0 {
		return false
	}
	for _, p := range projects {
		if !canManageProjectWorkflow(member, p) {
			return false
		}
	}
	return true
}

func (h *Handler) UpdateIssueWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return
	}
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	var req IssueWorkflowWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	// The exclusive catalog lock keeps a status archive from racing the step
	// validation below, and serializes concurrent edits of one workspace's
	// workflows.
	if err := qtx.LockIssueStatusCatalog(ctx, wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	current, err := qtx.GetIssueWorkflow(ctx, db.GetIssueWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	var projects []db.Project
	if current.IsDefault {
		projects, err = qtx.ListProjectsUsingDefaultIssueWorkflow(ctx, wsUUID)
	} else {
		projects, err = qtx.ListProjectsUsingIssueWorkflow(ctx, db.ListProjectsUsingIssueWorkflowParams{WorkspaceID: wsUUID, WorkflowID: current.ID})
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	if !canEditWorkflowStatuses(member, current, projects) {
		writeError(w, http.StatusForbidden, "insufficient permissions")
		return
	}
	currentKeys, err := issueworkflow.DecodeKeys(current.Steps)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read workflow")
		return
	}
	name, description, keys := current.Name, current.Description, currentKeys
	if req.Name != nil && !current.IsDefault {
		name = *req.Name
	}
	if req.Description != nil {
		description = *req.Description
	}
	var createdStatuses []db.IssueStatus
	if req.Steps != nil {
		var msg string
		keys, createdStatuses, msg, err = resolveStepInputs(ctx, qtx, wsUUID, *req.Steps)
		if msg != "" {
			writeErrorCode(w, http.StatusBadRequest, "invalid_workflow", msg)
			return
		}
		if err != nil {
			slog.Warn("UpdateIssueWorkflow statuses failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to save workflow")
			return
		}
	}
	name, description, keys = issueworkflow.Normalize(name, description, keys)
	catalog, err := h.workflowStatusCatalog(ctx, qtx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue statuses")
		return
	}
	if err := issueworkflow.Validate(name, description, keys, current.IsDefault, catalog); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "invalid_workflow", err.Error())
		return
	}

	// Default accepts every status, so editing it never moves issues; issues
	// on a status it drops stay there and show under hidden columns.
	plan := workflowMappingPlan{Required: []StatusMappingRequirement{}, Unchanged: []StatusIssueCount{}}
	projectIDs := make([]pgtype.UUID, len(projects))
	for i, p := range projects {
		projectIDs[i] = p.ID
	}
	if !current.IsDefault && len(projectIDs) > 0 {
		next := issueworkflow.Definition{ID: current.ID, Name: name}
		next.Steps = make([]issueworkflow.Step, len(keys))
		for i, key := range keys {
			next.Steps[i] = issueworkflow.Step{StatusKey: key}
		}
		counts, err := qtx.CountProjectIssuesByStatus(ctx, db.CountProjectIssuesByStatusParams{WorkspaceID: wsUUID, ProjectIds: projectIDs})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to save workflow")
			return
		}
		categoryOf := func(key string) string { return catalog[key].Category }
		plan = mappingPlan(counts, next.Has, func(key string) string { return issueworkflow.MoveTarget(next, key, categoryOf) })
		if req.DryRun {
			writeJSON(w, http.StatusOK, map[string]any{"dry_run": true, "plan": plan})
			return
		}
		if msg := checkMapping(plan, req.StatusMapping, next.Has); msg != "" {
			writeMappingRequired(w, plan, msg)
			return
		}
	} else if req.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{"dry_run": true, "plan": plan})
		return
	}
	raw, err := issueworkflow.EncodeKeys(keys)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	row, err := qtx.UpdateIssueWorkflow(ctx, db.UpdateIssueWorkflowParams{
		ID:               current.ID,
		WorkspaceID:      wsUUID,
		Name:             name,
		Description:      description,
		InitialStatusKey: issueworkflow.StartStatus,
		Steps:            raw,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeErrorCode(w, http.StatusConflict, "workflow_name_taken", "a workflow with this name already exists")
			return
		}
		slog.Warn("UpdateIssueWorkflow failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	changed, cancelledWakeups, err := remapIssues(ctx, qtx, wsUUID, projectIDs, plan, req.StatusMapping)
	if err != nil {
		slog.Warn("UpdateIssueWorkflow remap failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to move issues to the new statuses")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	// Remapping is an administrative move: snapshots only, so it neither
	// notifies subscribers per issue nor looks like a handoff.
	h.publishIssueSnapshots(ctx, changed, "member", uuidToString(member.UserID))
	h.broadcastCancelledWakeups(ctx, wsUUID, cancelledWakeups)
	if len(createdStatuses) > 0 {
		h.publishIssueStatusChanged(workspaceID, member, "created")
	}
	h.publishIssueWorkflowChanged(workspaceID, member, "updated")
	h.writeIssueWorkflow(w, r, http.StatusOK, row)
}

func (h *Handler) DeleteIssueWorkflow(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return
	}
	idUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workflow id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockIssueStatusCatalog(ctx, wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	row, err := qtx.GetIssueWorkflow(ctx, db.GetIssueWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	if row.IsDefault {
		writeErrorCode(w, http.StatusBadRequest, "workflow_is_default", "the Default workflow cannot be deleted")
		return
	}
	projects, err := qtx.ListProjectsUsingIssueWorkflow(ctx, db.ListProjectsUsingIssueWorkflowParams{WorkspaceID: wsUUID, WorkflowID: idUUID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	if len(projects) > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":         fmt.Sprintf("%d project(s) still use this workflow; switch them to another workflow first", len(projects)),
			"code":          "workflow_in_use",
			"project_count": len(projects),
		})
		return
	}
	n, err := qtx.DeleteIssueWorkflow(ctx, db.DeleteIssueWorkflowParams{ID: idUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	if n == 0 {
		writeError(w, http.StatusNotFound, "workflow not found")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	h.publishIssueWorkflowChanged(workspaceID, member, "deleted")
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) publishIssueWorkflowChanged(workspaceID string, actor db.Member, action string) {
	h.publish(protocol.EventIssueWorkflowChanged, workspaceID, "member", uuidToString(actor.UserID), map[string]any{
		"action": action,
	})
}

// publishProjectWorkflowUpdate announces a project whose workflow settings
// changed and returns the project as the API shapes it.
func (h *Handler) publishProjectWorkflowUpdate(ctx context.Context, workspaceID string, member db.Member, project db.Project) ProjectResponse {
	resp := projectToResponse(project)
	resp.IssueCount, resp.DoneCount = h.loadProjectIssueStats(ctx, project.WorkspaceID, project.ID)
	resp.ResourceCount = h.loadProjectResourceCount(ctx, project.ID)
	h.publish(protocol.EventProjectUpdated, workspaceID, "member", uuidToString(member.UserID), map[string]any{"project": resp})
	return resp
}

// loadProjectForWorkflowWrite resolves the {id} project and checks that the
// caller may change its workflow settings.
func (h *Handler) loadProjectForWorkflowWrite(w http.ResponseWriter, r *http.Request) (db.Project, db.Member, string, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return db.Project{}, db.Member{}, "", false
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return db.Project{}, db.Member{}, "", false
	}
	projectUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "project id")
	if !ok {
		return db.Project{}, db.Member{}, "", false
	}
	project, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{ID: projectUUID, WorkspaceID: wsUUID})
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return db.Project{}, db.Member{}, "", false
	}
	if !canManageProjectWorkflow(member, project) {
		writeError(w, http.StatusForbidden, "only workspace admins and the project lead can change this project's workflow")
		return db.Project{}, db.Member{}, "", false
	}
	return project, member, workspaceID, true
}

type SetProjectWorkflowRequest struct {
	// WorkflowID is the workflow to use; null switches back to the workspace
	// Default workflow.
	WorkflowID    *string           `json:"workflow_id"`
	StatusMapping map[string]string `json:"status_mapping,omitempty"`
	DryRun        bool              `json:"dry_run,omitempty"`
}

// SetProjectWorkflow switches the workflow a project uses. Issues on statuses
// the new workflow does not list move to the statuses the caller maps them to,
// in the same transaction. The move is administrative: it neither reassigns
// issues nor starts runs. The project's handoffs stay keyed by status, so a
// column both workflows list keeps its handoff.
func (h *Handler) SetProjectWorkflow(w http.ResponseWriter, r *http.Request) {
	loaded, member, workspaceID, ok := h.loadProjectForWorkflowWrite(w, r)
	if !ok {
		return
	}
	wsUUID := loaded.WorkspaceID
	var req SetProjectWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var targetID pgtype.UUID
	if req.WorkflowID != nil && *req.WorkflowID != "" {
		if !h.requireProjectWorkflowsV1(w, r) {
			return
		}
		id, ok := parseUUIDOrBadRequest(w, *req.WorkflowID, "workflow_id")
		if !ok {
			return
		}
		targetID = id
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	// Shared catalog lock: a workflow edit (exclusive) cannot change the
	// target's steps between the census and the remap below.
	if err := qtx.LockIssueStatusCatalogShared(ctx, wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	project, err := qtx.LockProjectForWorkflowChange(ctx, db.LockProjectForWorkflowChangeParams{ID: loaded.ID, WorkspaceID: wsUUID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	var target *issueworkflow.Definition
	if targetID.Valid {
		row, err := qtx.GetIssueWorkflow(ctx, db.GetIssueWorkflowParams{ID: targetID, WorkspaceID: wsUUID})
		if err != nil {
			writeError(w, http.StatusBadRequest, "workflow not found in this workspace")
			return
		}
		def, err := issueworkflow.Decode(row)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read workflow")
			return
		}
		if def.IsDefault {
			// Choosing the Default row is the same as choosing Default.
			targetID = pgtype.UUID{}
		} else {
			target = &def
		}
	}
	catalog, err := h.workflowStatusCatalog(ctx, qtx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue statuses")
		return
	}
	// The Default workflow accepts every catalog status, archived included:
	// issues already on an archived status keep it, as they always have.
	allowed := func(key string) bool {
		if target == nil {
			_, ok := catalog[key]
			return ok
		}
		return target.Has(key)
	}
	targetAccepts := func(key string) bool {
		if target == nil {
			entry, ok := catalog[key]
			return ok && !entry.Archived
		}
		return target.Has(key)
	}
	counts, err := qtx.CountProjectIssuesByStatus(ctx, db.CountProjectIssuesByStatusParams{WorkspaceID: wsUUID, ProjectIds: []pgtype.UUID{project.ID}})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	categoryOf := func(key string) string { return catalog[key].Category }
	plan := mappingPlan(counts, allowed, func(key string) string {
		if target == nil {
			return issuestatus.Todo
		}
		return issueworkflow.MoveTarget(*target, key, categoryOf)
	})
	if req.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{"dry_run": true, "plan": plan})
		return
	}
	if msg := checkMapping(plan, req.StatusMapping, targetAccepts); msg != "" {
		writeMappingRequired(w, plan, msg)
		return
	}
	updated, err := qtx.SetProjectWorkflow(ctx, db.SetProjectWorkflowParams{ID: project.ID, WorkspaceID: wsUUID, WorkflowID: targetID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	changed, cancelledWakeups, err := remapIssues(ctx, qtx, wsUUID, []pgtype.UUID{project.ID}, plan, req.StatusMapping)
	if err != nil {
		slog.Warn("SetProjectWorkflow remap failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to move issues to the new statuses")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to change workflow")
		return
	}
	h.publishIssueSnapshots(ctx, changed, "member", uuidToString(member.UserID))
	h.broadcastCancelledWakeups(ctx, wsUUID, cancelledWakeups)
	resp := h.publishProjectWorkflowUpdate(ctx, workspaceID, member, updated)
	writeJSON(w, http.StatusOK, map[string]any{
		"project":        resp,
		"updated_issues": len(changed),
		"plan":           plan,
	})
}

// SetProjectWorkflowHandoff saves what the project does when an issue enters
// one of its columns: who it is handed to, the instructions their run gets,
// and where the handler moves it next. Saving "none" with no instructions
// clears the column. It changes only this project.
func (h *Handler) SetProjectWorkflowHandoff(w http.ResponseWriter, r *http.Request) {
	loaded, member, workspaceID, ok := h.loadProjectForWorkflowWrite(w, r)
	if !ok {
		return
	}
	var req IssueWorkflowHandoffPayload
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	step := issueworkflow.NormalizeHandoff(payloadToHandoff(chi.URLParam(r, "status"), req))
	if step.HandsOff() && !h.requireProjectWorkflowsV1(w, r) {
		return
	}
	if status, msg := h.validateHandoffHandler(r.Context(), r, workspaceID, step); status != 0 {
		writeErrorCode(w, status, "invalid_handoff", msg)
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save handoff")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if err := qtx.LockIssueStatusCatalogShared(ctx, loaded.WorkspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save handoff")
		return
	}
	project, err := qtx.LockProjectForWorkflowChange(ctx, db.LockProjectForWorkflowChangeParams{ID: loaded.ID, WorkspaceID: loaded.WorkspaceID})
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	def, err := issueworkflow.ForProjectRow(ctx, qtx, project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load project workflow")
		return
	}
	if err := issueworkflow.ValidateHandoff(step, *def); err != nil {
		writeErrorCode(w, http.StatusBadRequest, "invalid_handoff", err.Error())
		return
	}
	stored, err := issueworkflow.DecodeHandoffs(project.WorkflowHandoffs)
	if err != nil {
		stored = nil
	}
	next := make([]issueworkflow.Step, 0, len(stored)+1)
	replaced := false
	for _, s := range stored {
		if s.StatusKey == step.StatusKey {
			next = append(next, step)
			replaced = true
			continue
		}
		next = append(next, s)
	}
	if !replaced {
		next = append(next, step)
	}
	raw, err := issueworkflow.EncodeHandoffs(next)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save handoff")
		return
	}
	updated, err := qtx.SetProjectWorkflowHandoffs(ctx, db.SetProjectWorkflowHandoffsParams{ID: project.ID, WorkspaceID: project.WorkspaceID, WorkflowHandoffs: raw})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save handoff")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save handoff")
		return
	}
	writeJSON(w, http.StatusOK, h.publishProjectWorkflowUpdate(ctx, workspaceID, member, updated))
}

// PreviewProjectWorkflowBrief renders the brief a column's handler would
// receive, for a handoff being edited before it is saved.
func (h *Handler) PreviewProjectWorkflowBrief(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	if _, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found"); !ok {
		return
	}
	projectUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "project id")
	if !ok {
		return
	}
	var req IssueWorkflowHandoffPayload
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()
	def, project, err := issueworkflow.ForProject(ctx, h.Queries, wsUUID, projectUUID)
	if err != nil || def == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	step := issueworkflow.NormalizeHandoff(payloadToHandoff(req.StatusKey, req))
	if !def.Has(step.StatusKey) {
		writeError(w, http.StatusBadRequest, "status_key is not a column of this project")
		return
	}
	for i, s := range def.Steps {
		if s.StatusKey == step.StatusKey {
			def.Steps[i] = step
		}
	}
	resolver := issuestatus.NewResolver(wsUUID)
	brief := issueworkflow.Brief(issueworkflow.BriefInput{
		Workflow:        *def,
		ProjectName:     project.Title,
		StatusKey:       step.StatusKey,
		IssueIdentifier: h.getIssuePrefix(ctx, wsUUID) + "-123",
		StatusName: func(key string) string {
			return resolver.Name(ctx, h.Queries, key)
		},
		HandlerName: func(s issueworkflow.Step) string {
			switch s.Handler.Type {
			case issueworkflow.HandlerAgent, issueworkflow.HandlerSquad, issueworkflow.HandlerMember:
				id, err := parseUUIDString(s.Handler.ID)
				if err != nil {
					return s.Handler.Type
				}
				return h.actorDisplayName(ctx, wsUUID, s.Handler.Type, id)
			case issueworkflow.HandlerProjectLead:
				return "the project lead"
			case issueworkflow.HandlerCreator:
				return "the issue creator"
			}
			return ""
		},
	})
	writeJSON(w, http.StatusOK, map[string]any{"brief": brief})
}

// WorkflowHandoffRun is an active run of the agent or squad a handoff takes
// the issue from.
type WorkflowHandoffRun struct {
	TaskID    string  `json:"task_id"`
	AgentID   string  `json:"agent_id"`
	Status    string  `json:"status"`
	StartedAt *string `json:"started_at"`
}

type WorkflowHandoffPreviewResponse struct {
	Handoff              bool                 `json:"handoff"`
	WorkflowName         string               `json:"workflow_name,omitempty"`
	FromStatus           string               `json:"from_status"`
	ToStatus             string               `json:"to_status"`
	HandlerType          string               `json:"handler_type,omitempty"`
	HandlerID            string               `json:"handler_id,omitempty"`
	PreviousAssigneeType *string              `json:"previous_assignee_type"`
	PreviousAssigneeID   *string              `json:"previous_assignee_id"`
	PreviousRuns         []WorkflowHandoffRun `json:"previous_runs"`
	Brief                string               `json:"brief,omitempty"`
}

// PreviewWorkflowHandoff says what moving an issue to a status would do under
// its project's workflow, for the confirmation shown before a handoff: who
// the issue would go to, which runs of its current agent are still active,
// and the brief the new handler would receive. It writes nothing.
func (h *Handler) PreviewWorkflowHandoff(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		writeError(w, http.StatusBadRequest, "status is required")
		return
	}
	resp := WorkflowHandoffPreviewResponse{
		FromStatus:           issue.Status,
		ToStatus:             status,
		PreviousAssigneeType: textToPtr(issue.AssigneeType),
		PreviousAssigneeID:   uuidToPtr(issue.AssigneeID),
		PreviousRuns:         []WorkflowHandoffRun{},
	}
	params := db.UpdateIssueParams{
		ProjectID:    issue.ProjectID,
		Status:       pgtype.Text{String: status, Valid: true},
		AssigneeType: issue.AssigneeType,
		AssigneeID:   issue.AssigneeID,
	}
	hand, err := h.applyIssueWorkflow(r.Context(), issue, &params, true, false, nil)
	if err != nil {
		if writeIssueWorkflowError(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to resolve project workflow")
		return
	}
	if hand == nil {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.WorkflowName = hand.def.Name
	resp.Handoff = true
	resp.HandlerType = params.AssigneeType.String
	resp.HandlerID = uuidToString(params.AssigneeID)
	next := issue
	next.Status = status
	next.AssigneeType = params.AssigneeType
	next.AssigneeID = params.AssigneeID
	resp.Brief = h.workflowHandoffNote(r.Context(), next, hand)
	if issue.AssigneeType != params.AssigneeType || issue.AssigneeID != params.AssigneeID {
		for _, task := range h.assigneeActiveRuns(r.Context(), issue) {
			started := task.StartedAt
			if !started.Valid {
				started = task.CreatedAt
			}
			resp.PreviousRuns = append(resp.PreviousRuns, WorkflowHandoffRun{
				TaskID:    uuidToString(task.ID),
				AgentID:   uuidToString(task.AgentID),
				Status:    task.Status,
				StartedAt: timestampToPtr(started),
			})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
