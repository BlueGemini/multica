-- Handoff settings belong to the project, not the workflow (MUL-7420): a
-- workflow only decides which statuses a board shows and in what order, and
-- each project decides who a column hands an issue to. Two projects sharing a
-- workflow can hand the same step to different agents, and a project on the
-- Default workflow can set a handoff without creating a workflow at all.
--
-- workflow_handoffs is a JSONB array of {status_key, handler, instructions,
-- next_status_key, back_status_key}, saved one column at a time from the
-- board. NULL means no handoffs. Nullable with no default, so adding it is
-- metadata-only.
ALTER TABLE project ADD COLUMN IF NOT EXISTS workflow_handoffs JSONB;

-- Carry the handoffs saved on workflows so far over to every project using
-- them. The workflow rows keep only their statuses from here on.
UPDATE project AS p SET workflow_handoffs = (
    SELECT jsonb_agg(step ORDER BY ord)
    FROM issue_workflow AS w,
         jsonb_array_elements(w.steps) WITH ORDINALITY AS s(step, ord)
    WHERE w.id = p.workflow_id
      AND COALESCE(step->'handler'->>'type', 'none') <> 'none'
)
WHERE p.workflow_id IS NOT NULL
  AND p.workflow_handoffs IS NULL;

UPDATE issue_workflow SET steps = (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('status_key', step->>'status_key') ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(steps) WITH ORDINALITY AS s(step, ord)
);
