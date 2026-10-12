package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/multica-ai/multica/server/internal/qoderruntime"
	"github.com/multica-ai/multica/server/internal/util"
)

// Retired connections keep their encrypted journal until remote cancellation
// succeeds. Cleanup is independent of the former owner's access token.
func (h *Handler) cleanupInactiveQoder(ctx context.Context) {
	rows, err := h.DB.Query(ctx, `SELECT c.workspace_id::text FROM qoder_connection c WHERE c.journal_encrypted<>'' AND (NOT c.enabled OR NOT EXISTS(SELECT 1 FROM member m WHERE m.workspace_id=c.workspace_id AND m.user_id=c.owner_id AND m.role IN ('owner','admin')))`)
	if err != nil {
		return
	}
	var workspaces []string
	for rows.Next() {
		var ws string
		if rows.Scan(&ws) == nil {
			workspaces = append(workspaces, ws)
		}
	}
	rows.Close()
	for _, ws := range workspaces {
		cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_ = h.cleanupQoderJournal(cleanupCtx, ws)
		cancel()
	}
}

func (h *Handler) cleanupQoderJournal(ctx context.Context, ws string) error {
	cfg, _, _, _, err := h.readQoderSettings(ctx, ws)
	if err != nil {
		return err
	}
	var encrypted string
	if err = h.DB.QueryRow(ctx, `SELECT journal_encrypted FROM qoder_connection WHERE workspace_id=$1`, ws).Scan(&encrypted); err != nil {
		return err
	}
	if encrypted == "" {
		return nil
	}
	raw, err := h.openVCSSecret(encrypted)
	if err != nil {
		return err
	}
	var state struct {
		Run *struct {
			TaskID    string `json:"task_id"`
			SessionID string `json:"session_id"`
		} `json:"run"`
		Cleanup []string `json:"cleanup"`
	}
	if err = json.Unmarshal([]byte(raw), &state); err != nil {
		return err
	}
	sessions := state.Cleanup
	if state.Run != nil {
		if state.Run.SessionID != "" {
			sessions = append(sessions, state.Run.SessionID)
		}
		id, err := util.ParseUUID(state.Run.TaskID)
		if err != nil {
			return err
		}
		// The task transition is idempotent and does not require the removed owner.
		if _, err = h.TaskService.FailTask(ctx, id, "Qoder connection stopped", state.Run.SessionID, "", "", "qoder_cloud_execution", false, "", ""); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	for _, id := range sessions {
		if err = qoderruntime.CancelRemoteSession(ctx, cfg.BaseURL, cfg.QoderToken, id); err != nil {
			return fmt.Errorf("remote cleanup pending: %w", err)
		}
	}
	_, err = h.DB.Exec(ctx, `UPDATE qoder_connection SET journal_encrypted='' WHERE workspace_id=$1`, ws)
	return err
}

func (h *Handler) prepareQoderWorkspaceDeletion(ctx context.Context, ws string) error {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,19))`, ws); err != nil {
		return err
	}
	var busy bool
	err = tx.QueryRow(ctx, `UPDATE qoder_connection SET enabled=false,status='stopped' WHERE workspace_id=$1 RETURNING COALESCE(busy_until>now(),false)`, ws).Scan(&busy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if busy {
		return fmt.Errorf("remote step still active")
	}
	return h.cleanupQoderJournal(ctx, ws)
}
