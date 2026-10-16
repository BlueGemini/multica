-- The agents list asks for one member's pending drafts, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_draft_workspace_owner_status
    ON agent_draft (workspace_id, owner_id, status, updated_at DESC);
