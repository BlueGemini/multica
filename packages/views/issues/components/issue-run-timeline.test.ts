// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AgentTask, TaskUsage } from "@multica/core/types";
import {
  bucketRuns,
  bucketUnitFor,
  buildRunTimeline,
  cacheHitRate,
  groupRunsByDay,
  niceTicks,
  runIndexAt,
  shortModelName,
  timeTicks,
} from "./issue-run-timeline";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-09-24T10:00:00",
    completed_at: "2026-09-24T10:30:00",
    result: null,
    error: null,
    created_at: "2026-09-24T09:59:00",
    ...overrides,
  };
}

// claude-opus-5 at 5 / 25 / 0.50 / 6.25 per million: 1M output = $25.
function usage(outputTokens: number): TaskUsage[] {
  return [
    {
      provider: "anthropic",
      model: "claude-opus-5",
      input_tokens: 0,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  ];
}

const NOW = new Date("2026-09-27T18:00:00").getTime();

describe("buildRunTimeline", () => {
  it("orders runs by start and falls back to dispatch, then creation", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "late", started_at: "2026-09-25T09:00:00", completed_at: "2026-09-25T09:10:00" }),
        makeTask({
          id: "never-started",
          status: "cancelled",
          started_at: null,
          dispatched_at: null,
          created_at: "2026-09-24T08:00:00",
          completed_at: null,
        }),
        makeTask({ id: "dispatched", started_at: null, dispatched_at: "2026-09-24T09:00:00" }),
      ],
      NOW,
    );

    expect(timeline.runs.map((r) => r.task.id)).toEqual(["never-started", "dispatched", "late"]);
    // A run cancelled before it started still lands on the axis, as a sliver.
    const sliver = timeline.runs[0]!;
    expect(sliver.endMs).toBe(sliver.startMs);
  });

  it("stretches active runs to now and keeps them out of agent time", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "done" }),
        makeTask({ id: "live", status: "running", started_at: "2026-09-27T17:00:00", completed_at: null }),
      ],
      NOW,
    );

    const live = timeline.runs.find((r) => r.task.id === "live")!;
    expect(live.active).toBe(true);
    expect(live.endMs).toBe(NOW);
    expect(timeline.activeCount).toBe(1);
    expect(timeline.agentMs).toBe(30 * 60 * 1000);
    // Elapsed runs from the first start to now, while a run is still going.
    expect(timeline.elapsedMs).toBe(NOW - new Date("2026-09-24T10:00:00").getTime());
    expect(timeline.extent).toEqual([new Date("2026-09-24T10:00:00").getTime(), NOW]);
  });

  it("ignores deferred runs, which the execution log does not list", () => {
    const timeline = buildRunTimeline([makeTask({ status: "deferred" })], NOW);
    expect(timeline.runs).toHaveLength(0);
  });

  it("totals cost, tokens and the priciest run over priced runs only", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "a", usage: usage(400_000) }),
        makeTask({ id: "b", started_at: "2026-09-24T11:00:00", completed_at: "2026-09-24T11:30:00", usage: usage(200_000) }),
        makeTask({ id: "unpriced", started_at: "2026-09-24T13:00:00", completed_at: "2026-09-24T13:05:00" }),
      ],
      NOW,
    );

    expect(timeline.totalCost).toBe(15);
    expect(timeline.pricedCount).toBe(2);
    expect(timeline.maxRunCost).toBe(10);
    expect(timeline.tokens).toEqual({ input: 0, output: 600_000, cacheRead: 0, cacheWrite: 0, total: 600_000 });
  });

  it("splits the spend by agent and by model, largest first", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "a", agent_id: "agent-a", usage: usage(200_000) }),
        makeTask({
          id: "b",
          agent_id: "agent-b",
          started_at: "2026-09-24T11:00:00",
          usage: [
            ...usage(400_000),
            // claude-sonnet-5 at 2 / 10: 2M output = $20.
            { provider: "anthropic", model: "claude-sonnet-5", input_tokens: 0, output_tokens: 2_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
          ],
        }),
      ],
      NOW,
    );

    expect(timeline.costByAgent).toEqual([
      { key: "agent-b", cost: 30 },
      { key: "agent-a", cost: 5 },
    ]);
    // A run that used two models counts toward each at its own rate.
    expect(timeline.costByModel).toEqual([
      { key: "claude-sonnet-5", cost: 20 },
      { key: "claude-opus-5", cost: 15 },
    ]);
  });

  it("keeps a run without usage at no figure, not $0", () => {
    const timeline = buildRunTimeline([makeTask({ usage: [] })], NOW);
    expect(timeline.runs[0]!.usage).toBeNull();
    expect(timeline.runs[0]!.breakdown).toBeNull();
    expect(timeline.pricedCount).toBe(0);
  });

  it("splits a run's cost by what was billed", () => {
    const timeline = buildRunTimeline([makeTask({ usage: usage(1_000_000) })], NOW);
    expect(timeline.runs[0]!.breakdown).toEqual({ input: 0, output: 25, cacheRead: 0, cacheWrite: 0 });
  });

  it("puts each agent in its own lane, in order of first appearance", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "b1", agent_id: "agent-b", started_at: "2026-09-24T11:00:00" }),
        makeTask({ id: "a1", agent_id: "agent-a", started_at: "2026-09-24T10:00:00" }),
        makeTask({ id: "a2", agent_id: "agent-a", started_at: "2026-09-24T12:00:00", completed_at: "2026-09-24T12:30:00" }),
      ],
      NOW,
    );

    expect(timeline.lanes.map((l) => [l.agentId, l.runs.map((r) => r.task.id)])).toEqual([
      ["agent-a", ["a1", "a2"]],
      ["agent-b", ["b1"]],
    ]);
  });

  it("counts failed and cancelled runs", () => {
    const timeline = buildRunTimeline(
      [makeTask({ status: "failed" }), makeTask({ status: "cancelled" }), makeTask({ status: "cancelled" })],
      NOW,
    );
    expect([timeline.failedCount, timeline.cancelledCount]).toEqual([1, 2]);
  });
});

describe("cacheHitRate", () => {
  it("is the share of prompt tokens served from cache", () => {
    expect(cacheHitRate({ input: 100, cacheRead: 800, cacheWrite: 100 })).toBe(0.8);
  });

  it("has no rate without prompt tokens", () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe("bucketRuns", () => {
  const ms = (iso: string) => new Date(iso).getTime();

  it("picks hours, days or weeks from the span that holds runs", () => {
    expect(bucketUnitFor(6 * 60 * 60 * 1000)).toBe("hour");
    expect(bucketUnitFor(60 * 60 * 60 * 1000)).toBe("hour");
    expect(bucketUnitFor(5 * 24 * 60 * 60 * 1000)).toBe("day");
    expect(bucketUnitFor(90 * 24 * 60 * 60 * 1000)).toBe("week");
  });

  it("counts each run in the hour it started, padded towards now", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "a", started_at: "2026-09-24T10:10:00", completed_at: "2026-09-24T10:40:00", usage: usage(400_000) }),
        // Starts in the 10:00 bucket, ends in 11:00 — it still counts at 10:00.
        makeTask({ id: "b", started_at: "2026-09-24T10:50:00", completed_at: "2026-09-24T11:20:00", usage: usage(200_000) }),
        makeTask({ id: "c", started_at: "2026-09-24T13:00:00", completed_at: "2026-09-24T13:10:00" }),
      ],
      ms("2026-09-24T15:30:00"),
    );
    const { unit, buckets, domain } = bucketRuns(timeline, ms("2026-09-24T15:30:00"));

    expect(unit).toBe("hour");
    expect(buckets).toHaveLength(12);
    // Forward to now's hour first, then back from the first run.
    expect(domain).toEqual([ms("2026-09-24T04:00:00"), ms("2026-09-24T16:00:00")]);
    const at = (iso: string) => buckets.find((b) => b.startMs === ms(iso))!;
    expect(at("2026-09-24T10:00:00").runs.map((r) => r.task.id)).toEqual(["a", "b"]);
    expect(at("2026-09-24T10:00:00").cost).toBe(15);
    expect(at("2026-09-24T10:00:00").tokens.output).toBe(600_000);
    expect(at("2026-09-24T10:00:00").agentMs).toBe(60 * 60 * 1000);
    expect(at("2026-09-24T10:00:00").byAgent.get("agent-1")).toEqual({ cost: 15, agentMs: 60 * 60 * 1000 });
    expect(at("2026-09-24T11:00:00").runs).toHaveLength(0);
    // An unpriced run still lands in its bucket, at no cost.
    expect(at("2026-09-24T13:00:00").runs.map((r) => r.task.id)).toEqual(["c"]);
    expect(at("2026-09-24T13:00:00").cost).toBe(0);
  });

  it("buckets a multi-day issue by local day", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "a", started_at: "2026-09-20T23:30:00", completed_at: "2026-09-21T00:10:00" }),
        makeTask({ id: "b", started_at: "2026-09-24T09:00:00", completed_at: "2026-09-24T09:10:00" }),
      ],
      NOW,
    );
    const { unit, buckets } = bucketRuns(timeline, NOW);

    expect(unit).toBe("day");
    expect(buckets.every((b) => new Date(b.startMs).getHours() === 0)).toBe(true);
    expect(buckets.find((b) => b.runs.some((r) => r.task.id === "a"))!.startMs).toBe(ms("2026-09-20T00:00:00"));
  });

  it("starts weeks on Monday", () => {
    const timeline = buildRunTimeline(
      [
        makeTask({ id: "a", started_at: "2026-06-03T10:00:00", completed_at: "2026-06-03T10:10:00" }),
        makeTask({ id: "b", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T10:10:00" }),
      ],
      NOW,
    );
    const { unit, buckets } = bucketRuns(timeline, NOW);

    expect(unit).toBe("week");
    expect(buckets.every((b) => new Date(b.startMs).getDay() === 1)).toBe(true);
  });
});

describe("runIndexAt", () => {
  const MINUTE = 60_000;
  const { runs } = buildRunTimeline(
    [
      makeTask({ id: "a", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T10:30:00" }),
      makeTask({ id: "b", started_at: "2026-09-24T14:00:00", completed_at: "2026-09-24T14:00:20" }),
    ],
    NOW,
  );
  const at = (iso: string, slopMs = MINUTE) => {
    const i = runIndexAt(runs, new Date(iso).getTime(), slopMs);
    return i < 0 ? null : runs[i]!.task.id;
  };

  it("picks the run under the pointer", () => {
    expect(at("2026-09-24T10:15:00")).toBe("a");
  });

  it("reaches a sliver of a run within the slop", () => {
    // `b` lasts 20s; the pointer lands a few pixels — here 40s — off it.
    expect(at("2026-09-24T13:59:20")).toBe("b");
    expect(at("2026-09-24T14:01:00")).toBe("b");
  });

  it("reports no run between runs instead of snapping across the gap", () => {
    // Review repro (MUL-7780): the crosshair used to jump to whichever run
    // was nearest, hundreds of pixels from the pointer.
    expect(at("2026-09-24T11:00:00")).toBeNull();
    expect(at("2026-09-24T13:00:00")).toBeNull();
    expect(at("2026-09-25T00:00:00")).toBeNull();
  });

  it("prefers the run the pointer is inside over one it is merely near", () => {
    const { runs: adjacent } = buildRunTimeline(
      [
        makeTask({ id: "long", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T11:00:00" }),
        makeTask({ id: "blip", started_at: "2026-09-24T11:00:30", completed_at: "2026-09-24T11:00:40" }),
      ],
      NOW,
    );
    const i = runIndexAt(adjacent, new Date("2026-09-24T10:59:50").getTime(), MINUTE);
    expect(adjacent[i]!.task.id).toBe("long");
  });

  it("reaches a run nested inside a longer one", () => {
    // Review repro: A 09:00–12:00 wraps B 10:00–11:00. Over B, B must win.
    const { runs: nested } = buildRunTimeline(
      [
        makeTask({ id: "outer", started_at: "2026-09-24T09:00:00", completed_at: "2026-09-24T12:00:00" }),
        makeTask({ id: "inner", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T11:00:00" }),
      ],
      NOW,
    );
    const pick = (iso: string) => nested[runIndexAt(nested, new Date(iso).getTime(), MINUTE)]!.task.id;
    expect(pick("2026-09-24T10:30:00")).toBe("inner");
    expect(pick("2026-09-24T09:30:00")).toBe("outer");
    expect(pick("2026-09-24T11:30:00")).toBe("outer");
  });

  it("stays in the lane the pointer is over", () => {
    const { runs: lanes } = buildRunTimeline(
      [
        makeTask({ id: "lambda", agent_id: "agent-lambda", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T10:20:00" }),
        makeTask({ id: "emacs", agent_id: "agent-emacs", started_at: "2026-09-24T09:00:00", completed_at: "2026-09-24T12:00:00" }),
      ],
      NOW,
    );
    const t = new Date("2026-09-24T10:10:00").getTime();
    expect(lanes[runIndexAt(lanes, t, MINUTE)]!.task.id).toBe("lambda");
    expect(lanes[runIndexAt(lanes, t, MINUTE, "agent-emacs")]!.task.id).toBe("emacs");
  });

  it("has nothing to point at without runs", () => {
    expect(runIndexAt([], 0, MINUTE)).toBe(-1);
  });
});

describe("niceTicks", () => {
  it("steps in clean values and tops out at or above the max", () => {
    expect(niceTicks(166)).toEqual([50, 100, 150, 200]);
    expect(niceTicks(100)).toEqual([25, 50, 75, 100]);
    expect(niceTicks(2)).toEqual([0.5, 1, 1.5, 2]);
    expect(niceTicks(0.37)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("has nothing to mark without a total", () => {
    expect(niceTicks(0)).toEqual([]);
  });
});

describe("timeTicks", () => {
  it("marks local midnights across a multi-day issue", () => {
    const ticks = timeTicks([
      new Date("2026-09-23T20:00:00").getTime(),
      new Date("2026-09-27T18:00:00").getTime(),
    ]);
    expect(ticks.every((t) => t.kind === "day")).toBe(true);
    expect(ticks.map((t) => new Date(t.t).getDate())).toEqual([24, 25, 26, 27]);
    expect(ticks.every((t) => new Date(t.t).getHours() === 0)).toBe(true);
  });

  it("marks whole hours when the issue fits in a day", () => {
    const ticks = timeTicks([
      new Date("2026-09-24T09:40:00").getTime(),
      new Date("2026-09-24T15:10:00").getTime(),
    ]);
    expect(ticks.every((t) => t.kind === "hour")).toBe(true);
    expect(ticks.map((t) => new Date(t.t).getHours())).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it("thins daily ticks on a long issue", () => {
    const ticks = timeTicks([
      new Date("2026-08-01T00:00:00").getTime(),
      new Date("2026-09-27T00:00:00").getTime(),
    ]);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });
});

describe("groupRunsByDay", () => {
  it("lists newest day first, newest run first, with day totals", () => {
    const { runs } = buildRunTimeline(
      [
        makeTask({ id: "d1-a", started_at: "2026-09-24T10:00:00", completed_at: "2026-09-24T10:30:00", usage: usage(200_000) }),
        makeTask({ id: "d1-b", started_at: "2026-09-24T15:00:00", completed_at: "2026-09-24T15:10:00", usage: usage(400_000) }),
        makeTask({ id: "d2-a", started_at: "2026-09-25T09:00:00", completed_at: "2026-09-25T09:20:00" }),
      ],
      NOW,
    );

    const groups = groupRunsByDay(runs);
    expect(groups.map((g) => g.runs.map((r) => r.task.id))).toEqual([["d2-a"], ["d1-b", "d1-a"]]);
    expect(groups[1]!.cost).toBe(15);
    expect(groups[1]!.agentMs).toBe(40 * 60 * 1000);
  });
});

describe("shortModelName", () => {
  it("shortens the families it knows", () => {
    expect(shortModelName("claude-opus-5-5-high")).toBe("Opus 5.5 high");
    expect(shortModelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(shortModelName("anthropic/claude-opus-5[1m]")).toBe("Opus 5");
    expect(shortModelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(shortModelName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
  });

  it("leaves an unfamiliar id as it is", () => {
    expect(shortModelName("kimi-k2")).toBe("kimi-k2");
  });
});
