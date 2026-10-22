-- MUL-8154: bind daemon tokens to the runtime owner they were issued for.
-- A daemon_id can be re-registered by another member after its runtimes are
-- deleted; a token bound only to (workspace_id, daemon_id) would then reach
-- the new owner's runtimes. Daemon routes require owner_id to match the
-- runtime's owner for every non-Qoder-managed token.
ALTER TABLE daemon_token
    ADD COLUMN owner_id UUID REFERENCES "user"(id) ON DELETE CASCADE;

-- Backfill live tokens from the current runtimes of their daemon, only where
-- that daemon has exactly one owner. Ambiguous or ownerless daemons stay NULL
-- and are refused until re-issued (they expire within 24h). Qoder-managed
-- tokens are governed by cloud_agent_connection and stay NULL.
UPDATE daemon_token d
SET owner_id = o.owner_id
FROM (
    SELECT workspace_id, daemon_id, min(owner_id::text)::uuid AS owner_id
    FROM agent_runtime
    WHERE daemon_id IS NOT NULL
    GROUP BY workspace_id, daemon_id
    HAVING count(DISTINCT owner_id) = 1
       AND count(*) FILTER (WHERE owner_id IS NULL) = 0
) o
WHERE d.workspace_id = o.workspace_id
  AND d.daemon_id = o.daemon_id
  AND d.daemon_id NOT LIKE 'qoder-managed-%';
