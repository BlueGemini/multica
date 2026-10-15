import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { issueKeys } from "../issues/queries";
import { projectKeys } from "../projects/queries";
import type {
  IssueWorkflowWriteRequest,
  ListProjectsResponse,
  Project,
  SetProjectWorkflowHandoffRequest,
  SetProjectWorkflowRequest,
} from "../types";
import { issueWorkflowKeys } from "./queries";

/**
 * Workflow mutations (MUL-7420).
 *
 * Like the status catalog, the list refreshes through the
 * `issue_workflow:changed` realtime event; the writer only invalidates on
 * failure, when its own copy is the likely stale one. A project switch or a
 * step removal can move issues between statuses, and those moves arrive as
 * ordinary issue events.
 */

export function useCreateIssueWorkflow() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: IssueWorkflowWriteRequest) => api.createIssueWorkflow(data),
    onError: () => {
      qc.invalidateQueries({ queryKey: issueWorkflowKeys.all(wsId) });
    },
  });
}

export function useUpdateIssueWorkflow() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & IssueWorkflowWriteRequest) =>
      api.updateIssueWorkflow(id, data),
    onError: () => {
      qc.invalidateQueries({ queryKey: issueWorkflowKeys.all(wsId) });
    },
  });
}

export function useDeleteIssueWorkflow() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.deleteIssueWorkflow(id),
    onError: () => {
      qc.invalidateQueries({ queryKey: issueWorkflowKeys.all(wsId) });
    },
  });
}

export function useSetProjectWorkflow() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ projectId, ...data }: { projectId: string } & SetProjectWorkflowRequest) =>
      api.setProjectWorkflow(projectId, data),
    onSettled: (_data, _error, { projectId }) => {
      qc.invalidateQueries({ queryKey: projectKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(wsId, projectId) });
      // project_ids on each workflow row changed.
      qc.invalidateQueries({ queryKey: issueWorkflowKeys.all(wsId) });
      // Remapped issues moved columns.
      qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
  });
}

function useProjectWorkflowWriteSettled() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return (project: Project | undefined, projectId: string) => {
    if (project) {
      qc.setQueryData<ListProjectsResponse>(projectKeys.list(wsId), (old) =>
        old && { ...old, projects: old.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p)) },
      );
    }
    qc.invalidateQueries({ queryKey: projectKeys.list(wsId) });
    qc.invalidateQueries({ queryKey: projectKeys.detail(wsId, projectId) });
  };
}

/** Saves this project's handoff for one column. */
export function useSetProjectWorkflowHandoff() {
  const settled = useProjectWorkflowWriteSettled();
  return useMutation({
    mutationFn: ({ projectId, statusKey, ...data }: { projectId: string; statusKey: string } & SetProjectWorkflowHandoffRequest) =>
      api.setProjectWorkflowHandoff(projectId, statusKey, data),
    onSettled: (project, _error, { projectId }) => settled(project, projectId),
  });
}
