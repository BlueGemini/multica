-- Dropping the constraint drops the index it took over, leaving 584's down
-- direction a no-op via IF EXISTS.
ALTER TABLE agent_draft DROP CONSTRAINT IF EXISTS agent_draft_pkey;
