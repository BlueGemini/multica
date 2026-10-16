package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	maxAgentDraftConfigBytes = 256 * 1024
	maxAgentDraftNameLength  = 255
	maxAgentDraftListIDs     = 100
)

// AgentDraftConfig is the configuration a draft carries. Field names match the
// create API where they overlap; access is expressed the way the editors show
// it (permission_scope + member_ids/team_ids) and turned into permission_mode
// and invocation_targets only when the draft is created.
type AgentDraftConfig struct {
	Name                 string                     `json:"name"`
	Description          string                     `json:"description"`
	Instructions         string                     `json:"instructions"`
	ConversationStarters []AgentConversationStarter `json:"conversation_starters"`
	AvatarURL            *string                    `json:"avatar_url"`
	RuntimeID            string                     `json:"runtime_id"`
	Model                string                     `json:"model"`
	ThinkingLevel        string                     `json:"thinking_level"`
	ServiceTier          string                     `json:"service_tier"`
	SkillIDs             []string                   `json:"skill_ids"`
	PermissionScope      string                     `json:"permission_scope"`
	MemberIDs            []string                   `json:"member_ids"`
	TeamIDs              []string                   `json:"team_ids"`
}

type AgentDraftResponse struct {
	ID                  string           `json:"id"`
	WorkspaceID         string           `json:"workspace_id"`
	OwnerID             string           `json:"owner_id"`
	AuthorType          string           `json:"author_type"`
	AuthorID            string           `json:"author_id"`
	SourceIssueID       *string          `json:"source_issue_id"`
	SourceChatSessionID *string          `json:"source_chat_session_id"`
	Status              string           `json:"status"`
	Config              AgentDraftConfig `json:"config"`
	Version             int32            `json:"version"`
	CreatedAgentID      *string          `json:"created_agent_id"`
	CreatedAt           string           `json:"created_at"`
	UpdatedAt           string           `json:"updated_at"`
	// Mention is the Markdown link that renders this draft as a card in chat
	// messages and comments. Agents paste it into their reply.
	Mention string `json:"mention"`
}

type ListAgentDraftsResponse struct {
	Drafts []AgentDraftResponse `json:"drafts"`
}

type AgentDraftWriteRequest struct {
	Config map[string]json.RawMessage `json:"config"`
}

var agentDraftMentionLabelEscaper = strings.NewReplacer("[", "", "]", "", "\n", " ", "\r", " ")

func agentDraftMention(id, name string) string {
	label := strings.TrimSpace(agentDraftMentionLabelEscaper.Replace(name))
	if label == "" {
		label = "Agent draft"
	}
	return fmt.Sprintf("[%s](mention://agent-draft/%s)", label, id)
}

func agentDraftToResponse(d db.AgentDraft) AgentDraftResponse {
	var cfg AgentDraftConfig
	_ = json.Unmarshal(d.Config, &cfg)
	normaliseAgentDraftSlices(&cfg)
	id := uuidToString(d.ID)
	return AgentDraftResponse{
		ID:                  id,
		WorkspaceID:         uuidToString(d.WorkspaceID),
		OwnerID:             uuidToString(d.OwnerID),
		AuthorType:          d.AuthorType,
		AuthorID:            uuidToString(d.AuthorID),
		SourceIssueID:       uuidToPtr(d.SourceIssueID),
		SourceChatSessionID: uuidToPtr(d.SourceChatSessionID),
		Status:              d.Status,
		Config:              cfg,
		Version:             d.Version,
		CreatedAgentID:      uuidToPtr(d.CreatedAgentID),
		CreatedAt:           timestampToString(d.CreatedAt),
		UpdatedAt:           timestampToString(d.UpdatedAt),
		Mention:             agentDraftMention(id, cfg.Name),
	}
}

func normaliseAgentDraftSlices(cfg *AgentDraftConfig) {
	if cfg.ConversationStarters == nil {
		cfg.ConversationStarters = []AgentConversationStarter{}
	}
	if cfg.SkillIDs == nil {
		cfg.SkillIDs = []string{}
	}
	if cfg.MemberIDs == nil {
		cfg.MemberIDs = []string{}
	}
	if cfg.TeamIDs == nil {
		cfg.TeamIDs = []string{}
	}
}

var agentDraftConfigFields = map[string]bool{
	"name":                  true,
	"description":           true,
	"instructions":          true,
	"conversation_starters": true,
	"avatar_url":            true,
	"runtime_id":            true,
	"model":                 true,
	"thinking_level":        true,
	"service_tier":          true,
	"skill_ids":             true,
	"permission_scope":      true,
	"member_ids":            true,
	"team_ids":              true,
}

// mergeAgentDraftConfig applies a partial config onto the stored one. Keys
// present in patch replace the stored value (null resets it); absent keys are
// kept, so a member editing one field and an agent setting another never
// overwrite each other's work.
func mergeAgentDraftConfig(stored []byte, patch map[string]json.RawMessage) (AgentDraftConfig, error) {
	merged := map[string]json.RawMessage{}
	if len(stored) > 0 {
		if err := json.Unmarshal(stored, &merged); err != nil {
			return AgentDraftConfig{}, fmt.Errorf("stored draft is unreadable")
		}
	}
	for key, value := range patch {
		if !agentDraftConfigFields[key] {
			return AgentDraftConfig{}, fmt.Errorf("unknown config field %q", key)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			delete(merged, key)
			continue
		}
		merged[key] = value
	}
	payload, err := json.Marshal(merged)
	if err != nil {
		return AgentDraftConfig{}, fmt.Errorf("invalid config")
	}
	var cfg AgentDraftConfig
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return AgentDraftConfig{}, fmt.Errorf("invalid config: %v", err)
	}
	return cfg, nil
}

// validateAgentDraftConfig checks what a draft can already get wrong while it
// is still being written. Completeness (a name, a runtime, filled starters) is
// left to the create that consumes it, because every editor saves partial
// work.
func (h *Handler) validateAgentDraftConfig(r *http.Request, workspaceID pgtype.UUID, cfg *AgentDraftConfig) error {
	cfg.Name = strings.TrimSpace(cfg.Name)
	normaliseAgentDraftSlices(cfg)
	if utf8.RuneCountInString(cfg.Name) > maxAgentDraftNameLength {
		return fmt.Errorf("name must be %d characters or fewer", maxAgentDraftNameLength)
	}
	if utf8.RuneCountInString(cfg.Description) > maxAgentDescriptionLength {
		return fmt.Errorf("description must be %d characters or fewer", maxAgentDescriptionLength)
	}
	if len(cfg.ConversationStarters) > maxAgentConversationStarters {
		return fmt.Errorf("conversation_starters must contain at most %d items", maxAgentConversationStarters)
	}
	for i, item := range cfg.ConversationStarters {
		if utf8.RuneCountInString(item.Label) > maxAgentConversationStarterLabel {
			return fmt.Errorf("conversation_starters[%d].label must be %d characters or fewer", i, maxAgentConversationStarterLabel)
		}
		if utf8.RuneCountInString(item.Prompt) > maxAgentConversationStarterLength {
			return fmt.Errorf("conversation_starters[%d].prompt must be %d characters or fewer", i, maxAgentConversationStarterLength)
		}
	}
	switch cfg.PermissionScope {
	case "":
		cfg.PermissionScope = "private"
	case "private", "workspace", "members":
	default:
		return fmt.Errorf("permission_scope must be private, workspace or members")
	}
	for field, ids := range map[string][]string{"skill_ids": cfg.SkillIDs, "member_ids": cfg.MemberIDs, "team_ids": cfg.TeamIDs} {
		if len(ids) > maxAgentDraftListIDs {
			return fmt.Errorf("%s must contain at most %d items", field, maxAgentDraftListIDs)
		}
		for _, id := range ids {
			if _, err := util.ParseUUID(id); err != nil {
				return fmt.Errorf("%s contains an invalid id %q", field, id)
			}
		}
	}
	if cfg.RuntimeID != "" {
		runtimeUUID, err := util.ParseUUID(cfg.RuntimeID)
		if err != nil {
			return fmt.Errorf("invalid runtime_id")
		}
		if _, err := h.Queries.GetAgentRuntimeForWorkspace(r.Context(), db.GetAgentRuntimeForWorkspaceParams{
			ID:          runtimeUUID,
			WorkspaceID: workspaceID,
		}); err != nil {
			return fmt.Errorf("runtime_id is not a runtime in this workspace")
		}
	}
	for _, id := range cfg.SkillIDs {
		skillUUID, _ := util.ParseUUID(id)
		if _, err := h.Queries.GetSkillInWorkspace(r.Context(), db.GetSkillInWorkspaceParams{
			ID:          skillUUID,
			WorkspaceID: workspaceID,
		}); err != nil {
			return fmt.Errorf("skill %s does not belong to this workspace", id)
		}
	}
	return nil
}

func decodeAgentDraftWriteRequest(w http.ResponseWriter, r *http.Request) (AgentDraftWriteRequest, bool) {
	var req AgentDraftWriteRequest
	body := http.MaxBytesReader(w, r.Body, maxAgentDraftConfigBytes)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "draft is too large")
			return req, false
		}
		writeError(w, http.StatusBadRequest, "invalid request body")
		return req, false
	}
	return req, true
}

// agentDraftTaskSource returns the issue and chat session of the task an
// agent is writing from, so its draft can point back to the conversation it
// was proposed in.
func (h *Handler) agentDraftTaskSource(r *http.Request) (issueID, chatSessionID pgtype.UUID) {
	taskUUID, err := util.ParseUUID(r.Header.Get("X-Task-ID"))
	if err != nil {
		return
	}
	task, err := h.Queries.GetAgentTask(r.Context(), taskUUID)
	if err != nil {
		return
	}
	return task.IssueID, task.ChatSessionID
}

// CreateAgentDraft starts a draft. Members and agents may both write drafts;
// the owner is always the member behind the request — for an agent, the member
// its task runs on behalf of — because only that member can confirm it.
func (h *Handler) CreateAgentDraft(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	req, ok := decodeAgentDraftWriteRequest(w, r)
	if !ok {
		return
	}
	cfg, err := mergeAgentDraftConfig(nil, req.Config)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.validateAgentDraftConfig(r, workspaceUUID, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	stored, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode draft")
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	params := db.CreateAgentDraftParams{
		ID:          dbid.NewV7(),
		WorkspaceID: workspaceUUID,
		OwnerID:     parseUUID(userID),
		AuthorType:  actorType,
		AuthorID:    parseUUID(actorID),
		Config:      stored,
	}
	if actorType == "agent" {
		params.SourceIssueID, params.SourceChatSessionID = h.agentDraftTaskSource(r)
	}
	draft, err := h.Queries.CreateAgentDraft(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create agent draft")
		return
	}
	h.publishAgentDraftEvent(protocol.EventAgentDraftCreated, workspaceID, actorType, actorID, draft)
	writeJSON(w, http.StatusCreated, agentDraftToResponse(draft))
}

// ListAgentDrafts returns the caller's own drafts. An agent sees the drafts of
// the member it works for, which is how it finds the draft it is refining.
func (h *Handler) ListAgentDrafts(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	switch status {
	case "":
		status = "pending"
	case "pending", "created", "discarded":
	default:
		writeError(w, http.StatusBadRequest, "status must be pending, created or discarded")
		return
	}
	rows, err := h.Queries.ListAgentDraftsByOwner(r.Context(), db.ListAgentDraftsByOwnerParams{
		WorkspaceID: workspaceUUID,
		OwnerID:     parseUUID(userID),
		Status:      status,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list agent drafts")
		return
	}
	drafts := make([]AgentDraftResponse, 0, len(rows))
	for _, row := range rows {
		drafts = append(drafts, agentDraftToResponse(row))
	}
	writeJSON(w, http.StatusOK, ListAgentDraftsResponse{Drafts: drafts})
}

// GetAgentDraft is readable by every workspace member: a draft card in a
// shared issue or chat has to render for whoever opens it. Only the owner can
// change or confirm it.
func (h *Handler) GetAgentDraft(w http.ResponseWriter, r *http.Request) {
	draft, ok := h.loadAgentDraft(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, agentDraftToResponse(draft))
}

func (h *Handler) loadAgentDraft(w http.ResponseWriter, r *http.Request) (db.AgentDraft, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return db.AgentDraft{}, false
	}
	draftUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "draft id")
	if !ok {
		return db.AgentDraft{}, false
	}
	draft, err := h.Queries.GetAgentDraftInWorkspace(r.Context(), db.GetAgentDraftInWorkspaceParams{
		ID:          draftUUID,
		WorkspaceID: workspaceUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "agent draft not found")
			return db.AgentDraft{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent draft")
		return db.AgentDraft{}, false
	}
	return draft, true
}

// lockOwnedPendingDraft locks a draft for a write by its owner. The owner
// check runs on the locked row, and so does the status check: a confirm or
// discard that committed while this request waited must win.
func (h *Handler) lockOwnedPendingDraft(w http.ResponseWriter, r *http.Request, qtx *db.Queries, userID string) (db.AgentDraft, bool) {
	workspaceUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return db.AgentDraft{}, false
	}
	draftUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "draft id")
	if !ok {
		return db.AgentDraft{}, false
	}
	draft, err := qtx.LockAgentDraftForUpdate(r.Context(), db.LockAgentDraftForUpdateParams{
		ID:          draftUUID,
		WorkspaceID: workspaceUUID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "agent draft not found")
			return db.AgentDraft{}, false
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent draft")
		return db.AgentDraft{}, false
	}
	if uuidToString(draft.OwnerID) != userID {
		writeError(w, http.StatusForbidden, "only the draft's owner can change it")
		return db.AgentDraft{}, false
	}
	if draft.Status != "pending" {
		writeError(w, http.StatusConflict, fmt.Sprintf("agent draft is already %s", draft.Status))
		return db.AgentDraft{}, false
	}
	return draft, true
}

// UpdateAgentDraft merges a partial config into a pending draft.
func (h *Handler) UpdateAgentDraft(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	req, ok := decodeAgentDraftWriteRequest(w, r)
	if !ok {
		return
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update agent draft")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	locked, ok := h.lockOwnedPendingDraft(w, r, qtx, userID)
	if !ok {
		return
	}
	cfg, err := mergeAgentDraftConfig(locked.Config, req.Config)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.validateAgentDraftConfig(r, workspaceUUID, &cfg); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	stored, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to encode draft")
		return
	}
	updated, err := qtx.UpdateAgentDraftConfig(r.Context(), db.UpdateAgentDraftConfigParams{
		ID:     locked.ID,
		Config: stored,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update agent draft")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update agent draft")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishAgentDraftEvent(protocol.EventAgentDraftUpdated, workspaceID, actorType, actorID, updated)
	writeJSON(w, http.StatusOK, agentDraftToResponse(updated))
}

// DiscardAgentDraft closes a pending draft without creating an agent.
func (h *Handler) DiscardAgentDraft(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to discard agent draft")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	locked, ok := h.lockOwnedPendingDraft(w, r, qtx, userID)
	if !ok {
		return
	}
	discarded, err := qtx.DiscardAgentDraft(r.Context(), locked.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to discard agent draft")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to discard agent draft")
		return
	}
	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	h.publishAgentDraftEvent(protocol.EventAgentDraftUpdated, workspaceID, actorType, actorID, discarded)
	writeJSON(w, http.StatusOK, agentDraftToResponse(discarded))
}

// publishAgentDraftEvent carries ids only. Every member may read a draft, but
// the event fans out to the whole workspace and clients refetch what they show.
func (h *Handler) publishAgentDraftEvent(eventType, workspaceID, actorType, actorID string, draft db.AgentDraft) {
	h.publish(eventType, workspaceID, actorType, actorID, map[string]any{
		"draft_id": uuidToString(draft.ID),
		"owner_id": uuidToString(draft.OwnerID),
		"status":   draft.Status,
	})
}
