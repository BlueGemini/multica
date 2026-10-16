-- Agent drafts (MUL-8048): the configuration of an agent that does not exist
-- yet. Only the owner turns one into an agent; see CreateAgent's draft_id.

-- name: CreateAgentDraft :one
INSERT INTO agent_draft (
    id, workspace_id, owner_id, author_type, author_id,
    source_issue_id, source_chat_session_id, config, revision, revisions, follow_ups
) VALUES (
    sqlc.arg('id'), sqlc.arg('workspace_id'), sqlc.arg('owner_id'),
    sqlc.arg('author_type'), sqlc.arg('author_id'),
    sqlc.narg('source_issue_id'), sqlc.narg('source_chat_session_id'),
    sqlc.arg('config')::jsonb, sqlc.arg('revision'), sqlc.arg('revisions')::jsonb,
    sqlc.arg('follow_ups')::jsonb
)
RETURNING *;

-- name: GetAgentDraftInWorkspace :one
SELECT * FROM agent_draft
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id');

-- name: LockAgentDraftForUpdate :one
-- Serialises edits against each other and against the create that consumes
-- the draft, so a confirm can never commit a configuration nobody saw.
SELECT * FROM agent_draft
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
FOR UPDATE;

-- name: ListAgentDraftsByOwner :many
SELECT * FROM agent_draft
WHERE workspace_id = sqlc.arg('workspace_id')
  AND owner_id = sqlc.arg('owner_id')
  AND status = sqlc.arg('status')
ORDER BY updated_at DESC
LIMIT 100;

-- name: UpdateAgentDraftConfig :one
UPDATE agent_draft
SET config = sqlc.arg('config')::jsonb,
    follow_ups = sqlc.arg('follow_ups')::jsonb,
    revision = sqlc.arg('revision'),
    revisions = sqlc.arg('revisions')::jsonb,
    version = version + 1,
    updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'pending'
RETURNING *;

-- name: DiscardAgentDraft :one
UPDATE agent_draft
SET status = 'discarded',
    discard_reason = sqlc.arg('discard_reason'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'pending'
RETURNING *;

-- name: MarkAgentDraftCreated :one
UPDATE agent_draft
SET status = 'created',
    created_agent_id = sqlc.arg('created_agent_id'),
    updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'pending'
RETURNING *;
