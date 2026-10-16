-- Agent drafts (MUL-8048).
--
-- A draft is the configuration of an agent that does not exist yet. A member
-- fills it in by hand, or any agent writes it with `multica agent draft`; in
-- both cases only the owning member can turn it into an agent, by passing
-- draft_id to POST /api/agents.
--
-- owner_id is the member who will confirm. For an agent-authored draft it is
-- the member the task runs on behalf of. author_type/author_id record who
-- wrote it, and source_issue_id / source_chat_session_id where, so a created
-- agent keeps its provenance through created_agent_id.
--
-- config is JSONB because the editors save it as one object and nothing
-- queries individual fields; the handler validates its shape. No foreign keys
-- by project rule.
--
-- version counts every write, for the editors' merge. revision counts only
-- what an agent proposed: each agent write that changes something appends to
-- revisions (bounded, newest last) the config it left and the previous values
-- of the fields it changed, so a card can show what a revision changed and an
-- older card in the conversation knows it was superseded. A member's own edits
-- do not make revisions.
--
-- follow_ups are what the member still has to do once the agent exists (fill
-- in an environment variable, approve an autopilot); they are not config and
-- never reach the created agent. discard_reason is what the member told the
-- author when rejecting the draft.
--
-- id is attached as the primary key in 585 from the index built CONCURRENTLY
-- in 584 (repo convention, see 332-334).
CREATE TABLE IF NOT EXISTS agent_draft (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    owner_id UUID NOT NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id UUID NOT NULL,
    source_issue_id UUID,
    source_chat_session_id UUID,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'discarded')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    version INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    revisions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(revisions) = 'array'),
    follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(follow_ups) = 'array'),
    discard_reason TEXT NOT NULL DEFAULT '',
    created_agent_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
