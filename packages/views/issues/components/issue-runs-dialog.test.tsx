// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, TaskUsage } from "@multica/core/types";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import { renderWithI18n } from "../../test/i18n";

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

vi.mock("../../common/task-transcript", () => ({
  TranscriptButton: ({ title }: { title?: string }) => (
    <button type="button">{title ?? "Transcript"}</button>
  ),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Lambda" }),
}));

// The real label loads the issue's wakeup rules; the row only needs to use it.
vi.mock("./wakeup-source-chip", () => ({
  WakeupRunLabel: ({ render }: { render: (label: string) => React.ReactNode }) =>
    render("Wakeup · When CI finishes"),
}));

import { IssueRunsDialog } from "./issue-runs-dialog";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-27T09:00:00",
    completed_at: "2026-09-27T09:30:00",
    result: null,
    error: null,
    created_at: "2026-09-27T08:59:00",
    trigger_summary: "Initial run",
    ...overrides,
  };
}

// claude-opus-5 at 5 / 25 / 0.50 / 6.25 per million: 1M output = $25.
function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    input_tokens: 0,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...overrides,
  };
}

function open(tasks: AgentTask[], locale?: "zh-Hans") {
  return renderWithI18n(
    <IssueRunsDialog
      open
      onOpenChange={() => {}}
      issueId="issue-1"
      identifier="MUL-7680"
      issueTitle="Issue wakeups v2"
      tasks={tasks}
    />,
    { locale },
  );
}

beforeEach(() => {
  cleanup();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T18:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
  useCustomPricingStore.setState({ pricings: {} });
  cleanup();
});

describe("IssueRunsDialog", () => {
  it("names the issue and sums what the runs spent and took", () => {
    open([
      makeTask({ id: "a", usage: [usage()] }),
      makeTask({
        id: "b",
        status: "failed",
        started_at: "2026-09-26T10:00:00",
        completed_at: "2026-09-26T10:15:00",
        usage: [usage({ output_tokens: 200_000 })],
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByText("MUL-7680 · Issue wakeups v2")).toBeInTheDocument();
    // $25 + $5, 1.2M output tokens, 30m + 15m of agent time over 23h 30m.
    const stat = (label: string) => screen.getByRole("group", { name: label });
    expect(stat("Spent")).toHaveTextContent("$30.00");
    expect(stat("Tokens")).toHaveTextContent("1.2M");
    expect(stat("Output")).toHaveTextContent("1.2M");
    expect(stat("Agent time")).toHaveTextContent("45m· 23h 30m elapsed");
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Run activity: $30.00 across 2 runs" }),
    ).toBeInTheDocument();
  });

  it("splits the spend by agent and by model", () => {
    open([makeTask({ usage: [usage()] })]);

    const byModel = screen.getByRole("region", { name: "By model" });
    expect(within(byModel).getByText("Opus 5")).toBeInTheDocument();
    expect(within(byModel).getByTitle("claude-opus-5")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "By agent" })).getByText("Lambda")).toBeInTheDocument();
  });

  it("groups runs by day, newest first, with each day's total", () => {
    open([
      makeTask({ id: "old", trigger_summary: "Older run", started_at: "2026-09-26T10:00:00", completed_at: "2026-09-26T10:15:00", usage: [usage({ output_tokens: 200_000 })] }),
      makeTask({ id: "new", trigger_summary: "Newer run", usage: [usage()] }),
    ]);

    const today = screen.getByRole("region", { name: "Today" });
    const yesterday = screen.getByRole("region", { name: "Yesterday" });
    expect(within(today).getByText("Newer run")).toBeInTheDocument();
    expect(within(today).getByText("1 run · 30m · 1M tokens · $25.00")).toBeInTheDocument();
    expect(within(yesterday).getByText("Older run")).toBeInTheDocument();
    expect(
      today.compareDocumentPosition(yesterday) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("quotes what a person said and cleans the snapshot's markdown", () => {
    open([
      makeTask({
        trigger_comment_id: "comment-1",
        trigger_summary: "@Lambda fix conflicts &amp; ci",
        usage: [usage()],
      }),
    ]);

    expect(screen.getByText("“@Lambda fix conflicts & ci”")).toBeInTheDocument();
  });

  it("shows no figure — not $0 — for a run without usage", () => {
    open([
      makeTask({ id: "priced", usage: [usage()] }),
      makeTask({ id: "unpriced", status: "cancelled", started_at: "2026-09-27T10:00:00", completed_at: "2026-09-27T10:00:05" }),
    ]);

    expect(screen.getByTitle("No usage recorded")).toHaveTextContent("—");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("gives every terminal run a status a screen reader can read", () => {
    // Completed rows show their duration; the status word must still be there.
    open([
      makeTask({ id: "ok", usage: [usage()] }),
      makeTask({ id: "bad", status: "failed", started_at: "2026-09-27T11:00:00", completed_at: "2026-09-27T11:05:00", usage: [usage()] }),
    ]);

    expect(screen.getByText("Completed")).toHaveClass("sr-only");
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("flags models with no price on file", () => {
    open([makeTask({ usage: [usage({ provider: "acme", model: "made-up-model" })] })]);

    expect(screen.getByText(/No price on file for acme\/made-up-model/)).toBeInTheDocument();
  });

  it("re-prices when a custom model rate is saved", () => {
    // `estimateCost` reads the custom-rate store imperatively, so nothing
    // re-renders the dialog on a rate change unless it subscribes.
    open([
      makeTask({
        usage: [usage({ provider: "acme", model: "made-up-model", output_tokens: 0, input_tokens: 1_000_000 })],
      }),
    ]);
    expect(screen.queryByText("$7.00")).not.toBeInTheDocument();

    act(() => {
      useCustomPricingStore.getState().setCustomPricing("acme/made-up-model", {
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });

    expect(screen.getAllByText("$7.00").length).toBeGreaterThan(0);
  });

  // The plot column sits beside the lane labels; give it a width, which jsdom
  // does not lay out. Two runs today with "now" at 18:00 pad the hourly chart
  // to 07:00–19:00. Returns the x of a moment on that axis.
  function layOut(plot: HTMLElement, first = "2026-09-27T07:00:00", last = "2026-09-27T19:00:00") {
    plot.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 200, right: 1000, bottom: 200, x: 0, y: 0, toJSON: () => ({}) });
    const [d0, d1] = [new Date(first).getTime(), new Date(last).getTime()];
    return (iso: string) => ((new Date(iso).getTime() - d0) / (d1 - d0)) * 1000;
  }
  const hoverCard = (plot: HTMLElement) => plot.querySelector("[data-hover-card]") as HTMLElement | null;
  const twoRuns = () => [
    makeTask({ id: "early", trigger_summary: "Early run", started_at: "2026-09-27T09:00:00", completed_at: "2026-09-27T09:30:00", usage: [usage()] }),
    makeTask({ id: "late", trigger_summary: "Late run", started_at: "2026-09-27T15:00:00", completed_at: "2026-09-27T15:10:00", usage: [usage({ output_tokens: 200_000 })] }),
  ];

  it("draws a bar per hour, and empty hours as a baseline", () => {
    open(twoRuns());
    const plot = screen.getByRole("img").children[1] as HTMLElement;

    expect(plot.querySelectorAll("[data-bucket]")).toHaveLength(12);
    const bar = (iso: string) => plot.querySelector(`[data-bucket="${new Date(iso).getTime()}"]`) as HTMLElement;
    expect(bar("2026-09-27T09:00:00").style.height).not.toBe("");
    expect(bar("2026-09-27T12:00:00").style.height).toBe("");
  });

  it("follows the pointer: the hour above the lanes, the run on a lane", () => {
    open(twoRuns());
    const plot = screen.getByRole("img").children[1] as HTMLElement;
    const x = layOut(plot);

    fireEvent.pointerMove(plot, { clientX: x("2026-09-27T15:20:00") });
    const hour = within(hoverCard(plot)!);
    expect(hour.getByText("1 run · 10m agent time")).toBeInTheDocument();
    expect(hour.getByText("$5.00")).toBeInTheDocument();

    const lane = plot.querySelector('[data-lane="agent-1"]') as HTMLElement;
    fireEvent.pointerMove(lane, { clientX: x("2026-09-27T15:05:00") });
    expect(within(hoverCard(plot)!).getByText("Late run")).toBeInTheDocument();

    // Between runs on a lane there is no run to name; the hour answers instead.
    fireEvent.pointerMove(lane, { clientX: x("2026-09-27T12:30:00") });
    expect(within(hoverCard(plot)!).getByText("0 runs")).toBeInTheDocument();

    fireEvent.pointerLeave(plot);
    expect(hoverCard(plot)).not.toBeInTheDocument();
  });

  it("keeps the hover when the pointer drifts off the plot onto the lane labels", () => {
    open(twoRuns());
    const chart = screen.getByRole("img");
    const plot = chart.children[1] as HTMLElement;
    layOut(plot);

    // Left of the plot: clamped to the first hour.
    fireEvent.pointerMove(chart.children[0] as HTMLElement, { clientX: -40 });
    expect(hoverCard(plot)).toBeInTheDocument();
  });

  it("picks the run on the lane under the pointer when runs overlap", () => {
    // Review repro: a short Emacs run inside a long Lambda run.
    open([
      makeTask({ id: "long", agent_id: "agent-lambda", trigger_summary: "Long run", started_at: "2026-09-27T09:00:00", completed_at: "2026-09-27T12:00:00", usage: [usage()] }),
      makeTask({ id: "short", agent_id: "agent-emacs", trigger_summary: "Short run", started_at: "2026-09-27T10:00:00", completed_at: "2026-09-27T11:00:00", usage: [usage({ output_tokens: 200_000 })] }),
    ]);
    const plot = screen.getByRole("img").children[1] as HTMLElement;
    const x = layOut(plot);
    const lane = (agentId: string) => plot.querySelector(`[data-lane="${agentId}"]`) as HTMLElement;

    fireEvent.pointerMove(lane("agent-lambda"), { clientX: x("2026-09-27T10:30:00") });
    expect(within(hoverCard(plot)!).getByText("Long run")).toBeInTheDocument();

    fireEvent.pointerMove(lane("agent-emacs"), { clientX: x("2026-09-27T10:30:00") });
    expect(within(hoverCard(plot)!).getByText("Short run")).toBeInTheDocument();
  });

  it("switches the chart between cost, tokens and agent time", () => {
    open(twoRuns());

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByText("per hour · by token type")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent time" }));
    expect(screen.getByText("per hour · by agent")).toBeInTheDocument();
  });

  it("expands a run's details from a real button", () => {
    open([makeTask({ usage: [usage()] })]);

    const toggle = screen.getByRole("button", { name: "Run details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(within(details).getByText("claude-opus-5")).toBeInTheDocument();
    expect(within(details).getByText("Total")).toBeInTheDocument();
  });

  it("names a wakeup run by its rule, not as a quote", () => {
    // A wakeup run carries the thread's comment id and the rule's instruction
    // as its summary; neither is something a person said.
    open([
      makeTask({
        wakeup_id: "wakeup-1",
        trigger_comment_id: "comment-1",
        trigger_summary: "Wakeup: check CI and fix it",
        usage: [usage()],
      }),
    ]);

    expect(screen.getByTitle("Wakeup · When CI finishes")).toHaveTextContent("Wakeup · When CI finishes");
    expect(screen.queryByText(/“/)).not.toBeInTheDocument();
  });

  it("keeps the whole trigger reachable when one line truncates it", () => {
    const long = "把之前拆出去的三个子任务都合并回这个 PR，conditions / history / runaway protection 一起做完再提交";
    open([makeTask({ trigger_comment_id: "comment-1", trigger_summary: long, usage: [usage()] })]);

    expect(screen.getByText(`“${long}”`)).toHaveAttribute("title", `“${long}”`);
  });

  it("renders in the member's language", () => {
    open([makeTask({ usage: [usage()] })], "zh-Hans");

    expect(screen.getByRole("heading", { name: "运行记录" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "今天" })).toBeInTheDocument();
  });
});
