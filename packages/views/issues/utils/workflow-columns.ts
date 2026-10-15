import { useFeatureEnabled } from "@multica/core/config";
import { PROJECT_WORKFLOWS_V1_FLAG } from "@multica/core/feature-flags";
import { defaultWorkflow, useIssueWorkflows, useProjectWorkflow } from "@multica/core/issue-workflows";
import type { IssueStatus, IssueWorkflow } from "@multica/core/types";

/**
 * The status columns of a surface whose columns follow a workflow (MUL-7420):
 * the workflow's steps, in workflow order, narrowed to `visible` (hidden-column
 * preferences and status filters). Without a workflow the catalog-ordered
 * `visible` list passes through unchanged. `visible === null` returns every
 * step.
 */
export function workflowColumns(
  visible: readonly IssueStatus[] | null,
  workflow: IssueWorkflow | null,
): IssueStatus[] {
  if (!workflow) return visible ? [...visible] : [];
  const keys = workflow.steps.map((s) => s.status_key as IssueStatus);
  if (!visible) return keys;
  const allowed = new Set(visible);
  return keys.filter((key) => allowed.has(key));
}

/**
 * The workflow a surface's columns follow (MUL-7420). A project surface shows
 * its project's columns. Elsewhere, while workflows are on, columns follow
 * Default and other statuses wait in the hidden-columns panel — unless a
 * status filter picks keys explicitly, which shows exactly those.
 */
export function useColumnWorkflow(
  wsId: string,
  projectId: string | null | undefined,
  hasStatusFilter: boolean,
): { workflow: IssueWorkflow | null; hidesOutsideDefault: boolean } {
  const enabled = useFeatureEnabled(PROJECT_WORKFLOWS_V1_FLAG, false);
  const { workflows } = useIssueWorkflows(wsId);
  const projectWorkflow = useProjectWorkflow(wsId, projectId);
  if (projectId) return { workflow: projectWorkflow, hidesOutsideDefault: false };
  if (!enabled || hasStatusFilter) return { workflow: null, hidesOutsideDefault: false };
  const fallback = defaultWorkflow(workflows);
  return { workflow: fallback, hidesOutsideDefault: fallback !== null };
}
