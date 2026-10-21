// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import { projectListOptions } from "@multica/core/projects/queries";
import { memberListOptions } from "@multica/core/workspace/queries";
import { renderWithI18n } from "../test/i18n";
import { WorkflowEditorPage } from "./workflow-editor-page";

const mutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@multica/core/api", () => ({ api: {}, ApiError: class extends Error {}, clientErrorMessage: () => null }));
vi.mock("@multica/core/issue-workflows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/issue-workflows")>()),
  useIssueWorkflows: () => ({ workflows: [], isLoaded: true }),
  useCreateIssueWorkflow: () => mutation,
  useUpdateIssueWorkflow: () => mutation,
  useDeleteIssueWorkflow: () => mutation,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "ws-1", slug: "ws" }) }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({ useIssueStatuses: () => buildIssueStatusCatalog([]) }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "" }) }));

afterEach(cleanup);

function renderEditor(canCreateStatus: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectListOptions("ws-1").queryKey, { projects: [] } as never);
  qc.setQueryData(memberListOptions("ws-1").queryKey, [] as never);
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <WorkflowEditorPage
        workflowId={null}
        seed={null}
        template="content"
        canEdit
        canCreateStatus={canCreateStatus}
        onBack={() => {}}
        onOpen={() => {}}
      />
    </QueryClientProvider>,
  );
}

// Statuses are shared by every board, so only admins add them (MUL-8120).
describe("WorkflowEditorPage status creation", () => {
  it("blocks saving a template that needs new statuses for a member", () => {
    renderEditor(false);
    expect(screen.getByRole("alert").textContent).toMatch(/Only workspace admins can add statuses/);
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
  });

  it("lets an admin save the same template", () => {
    renderEditor(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
  });
});
