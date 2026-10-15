import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueWorkflow } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { WorkflowPill } from "./workflow-pill";

function workflow(id: string, name: string, isDefault: boolean): IssueWorkflow {
  return {
    id,
    workspace_id: "workspace-1",
    name,
    description: "",
    is_default: isDefault,
    steps: [],
    project_ids: [],
    created_at: "",
    updated_at: "",
  };
}

vi.mock("@multica/core/config", () => ({ useFeatureEnabled: () => true }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/issue-workflows", () => ({
  useIssueWorkflows: () => ({
    workflows: [workflow("wf-default", "Default", true), workflow("wf-delivery", "Delivery", false)],
  }),
}));

afterEach(cleanup);

describe("WorkflowPill", () => {
  it("opens the workflow list and reports the choice", async () => {
    const onChange = vi.fn();
    renderWithI18n(<WorkflowPill value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Default/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delivery/ }));

    expect(onChange).toHaveBeenCalledWith("wf-delivery");
  });
});
