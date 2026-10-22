-- Self-host telemetry V2 counts members who personally started an agent run in
-- the last 1/7/28 UTC days. The collector probes the latest direct_human run
-- per member, so its cost stays bounded by member count instead of task
-- history; without this index each probe would walk a member's whole history
-- under the collector's 2s statement timeout. Partial on direct_human keeps
-- autopilot and agent-delegation rows (the bulk of the queue) out of it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_task_queue_direct_human_originator
    ON agent_task_queue (originator_user_id, created_at)
    WHERE originator_source = 'direct_human' AND originator_user_id IS NOT NULL;
