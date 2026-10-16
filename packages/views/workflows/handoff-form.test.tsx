// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@multica/core/issue-statuses";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import type { IssueWorkflowStep } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import { HandoffFields } from "./handoff-form";

vi.mock("@multica/core/api", () => ({ api: {}, clientErrorMessage: () => null }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/issue-statuses/hooks", () => ({ useIssueStatuses: () => buildIssueStatusCatalog([]) }));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid={`avatar-${actorId}`} />,
}));

const WORKFLOW = {
  steps: ["todo", "in_progress", "in_review", "done"].map((status_key) => ({
    status_key,
    handler: { type: "none" as const },
    instructions: "",
  })),
};

function renderFields(step: IssueWorkflowStep, onPatch = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(agentListOptions("ws-1").queryKey, [{ id: "agent-1", name: "Builder", archived_at: null }] as never);
  qc.setQueryData(memberListOptions("ws-1").queryKey, [{ user_id: "user-1", name: "Ada" }] as never);
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <HandoffFields step={step} workflow={WORKFLOW} canEdit onPatch={onPatch} />
    </QueryClientProvider>,
  );
  return onPatch;
}

afterEach(cleanup);

describe("HandoffFields", () => {
  it("offers no handoff, an agent or a member — never a squad", () => {
    const onPatch = renderFields({ status_key: "in_progress", handler: { type: "none" }, instructions: "" });

    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("No handoff"),
      expect.stringContaining("Hand to an agent"),
      expect.stringContaining("Hand to a member"),
    ]);
    expect(screen.queryByText(/squad/i)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Hand to an agent/ }));

    expect(onPatch).toHaveBeenCalledWith({ handler: { type: "agent" } });
  });

  it("lists only agents for an agent handoff", async () => {
    const onPatch = renderFields({ status_key: "in_progress", handler: { type: "agent" }, instructions: "" });

    fireEvent.click(screen.getByRole("button", { name: "Choose an agent" }));
    fireEvent.click(await screen.findByText("Builder"));
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.queryByText("Project lead")).toBeNull();

    expect(onPatch).toHaveBeenCalledWith({ handler: { type: "agent", id: "agent-1" } });
  });

  it("lists the project lead and members for a member handoff, without instructions", async () => {
    const onPatch = renderFields({ status_key: "in_review", handler: { type: "member" }, instructions: "" });

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose a member" }));
    expect(await screen.findByText("Project lead")).toBeTruthy();
    expect(screen.queryByText("Builder")).toBeNull();
    fireEvent.click(screen.getByText("Ada"));

    expect(onPatch).toHaveBeenCalledWith({ handler: { type: "member", id: "user-1" } });
  });

  it("defaults the next status to the next column and tucks the rest away", () => {
    renderFields({ status_key: "in_progress", handler: { type: "agent", id: "agent-1" }, instructions: "" });

    expect(screen.getByText(/When done, moves to/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /back/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More options/ }));
    expect(screen.getAllByRole("combobox").length).toBe(2);
  });
});
