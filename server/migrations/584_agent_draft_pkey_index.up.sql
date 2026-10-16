-- Backing index for agent_draft's primary key, attached in 585.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_draft_pkey_uidx
    ON agent_draft (id);
