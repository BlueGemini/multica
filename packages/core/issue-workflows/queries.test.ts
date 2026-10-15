// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IssueWorkflow, IssueWorkflowStep } from "../types";
import {
  resolveProjectWorkflow,
  stepHandsOff,
  statusAcceptsHandoff,
  workflowAllowsStatus,
  workflowMiddleKeys,
  workflowNextStatus,
  workflowStep,
} from "./queries";

const manual = (status_key: string): IssueWorkflowStep => ({ status_key, handler: { type: "none" }, instructions: "" });

const columns = (...middle: string[]) =>
  ["backlog", "todo", ...middle, "blocked", "done", "cancelled"].map(manual);

const defaultWorkflow: IssueWorkflow = {
  id: "wf-default",
  workspace_id: "ws-1",
  name: "Default",
  description: "",
  is_default: true,
  steps: columns("in_progress", "in_review"),
  project_ids: [],
  created_at: "",
  updated_at: "",
};

const content: IssueWorkflow = {
  ...defaultWorkflow,
  id: "wf-content",
  name: "Content",
  is_default: false,
  steps: columns("drafting", "editing"),
};

const lead: IssueWorkflowStep = { status_key: "in_review", handler: { type: "project_lead" }, instructions: "Review it." };

describe("project workflow resolution (MUL-7420)", () => {
  it("uses the project's workflow, else Default", () => {
    expect(resolveProjectWorkflow([defaultWorkflow, content], { workflow_id: "wf-content" })?.id).toBe("wf-content");
    expect(resolveProjectWorkflow([defaultWorkflow, content], { workflow_id: null })?.id).toBe("wf-default");
    // A dangling reference renders as Default, like the server treats it.
    expect(resolveProjectWorkflow([defaultWorkflow, content], { workflow_id: "gone" })?.id).toBe("wf-default");
  });

  it("is unknown while workflows load or without a project", () => {
    expect(resolveProjectWorkflow(undefined, { workflow_id: null })).toBeNull();
    expect(resolveProjectWorkflow([defaultWorkflow], undefined)).toBeNull();
    expect(resolveProjectWorkflow([], { workflow_id: null })).toBeNull();
  });

  it("puts the project's handoffs on its columns", () => {
    const resolved = resolveProjectWorkflow([defaultWorkflow], {
      workflow_id: null,
      workflow_handoffs: [lead, { ...lead, status_key: "done" }, { ...lead, status_key: "gone" }],
    });
    expect(stepHandsOff(workflowStep(resolved, "in_review"))).toBe(true);
    expect(workflowStep(resolved, "in_review")?.instructions).toBe("Review it.");
    // Closing columns never hand off, and handoffs on statuses the board lacks are ignored.
    expect(stepHandsOff(workflowStep(resolved, "done"))).toBe(false);
    expect(resolved?.steps).toHaveLength(7);
    expect(defaultWorkflow.steps[3]?.handler.type).toBe("none");
  });
});

describe("workflow helpers (MUL-7420)", () => {
  it("allows any status under Default and only listed ones under a named workflow", () => {
    expect(workflowAllowsStatus(null, "drafting")).toBe(true);
    expect(workflowAllowsStatus(defaultWorkflow, "drafting")).toBe(true);
    expect(workflowAllowsStatus(content, "drafting")).toBe(true);
    expect(workflowAllowsStatus(content, "in_progress")).toBe(false);
  });

  it("names the middle columns and who may hand off", () => {
    expect(workflowMiddleKeys(content)).toEqual(["drafting", "editing"]);
    expect(statusAcceptsHandoff("todo")).toBe(true);
    expect(statusAcceptsHandoff("blocked")).toBe(true);
    expect(statusAcceptsHandoff("backlog")).toBe(false);
    expect(statusAcceptsHandoff("done")).toBe(false);
  });

  it("points a step at the next column unless it names its own", () => {
    expect(workflowNextStatus(content, "drafting")).toBe("editing");
    // blocked is a detour, not the next step.
    expect(workflowNextStatus(content, "editing")).toBe("done");
    const own = { ...content, steps: content.steps.map((s) => (s.status_key === "drafting" ? { ...s, next_status_key: "done" } : s)) };
    expect(workflowNextStatus(own, "drafting")).toBe("done");
    expect(workflowNextStatus(content, "cancelled")).toBe("");
    expect(workflowNextStatus(content, "missing")).toBe("");
  });
});
