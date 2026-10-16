import type { AgentTask } from "@multica/core/types";
import {
  estimateCost,
  estimateCostBreakdown,
  summarizeTaskUsage,
  type CostBreakdown,
  type TaskUsageSummary,
} from "../../runtimes/utils";
import { taskDurationMs } from "./task-run-labels";

// Pure data for the issue's run timeline: the sidebar's per-run cost bars and
// the Runs dialog they open. Everything the two surfaces draw — bar heights,
// shares, day groups, totals — is derived here, so the rendering
// code only maps numbers to pixels and the arithmetic has one place to be
// tested.

const ACTIVE_STATUSES = new Set<AgentTask["status"]>([
  "queued",
  "dispatched",
  "waiting_local_directory",
  "running",
]);
const TERMINAL_STATUSES = new Set<AgentTask["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

export interface TimelineRun {
  task: AgentTask;
  /** When the run started working; falls back to dispatch, then creation. */
  startMs: number;
  /** When it finished, or `nowMs` for a run that is still active. */
  endMs: number;
  active: boolean;
  /** Finished-run wall time; null for active runs and runs that never started. */
  durationMs: number | null;
  /** Null when the run recorded no usage — "no figure", never "free". */
  usage: TaskUsageSummary | null;
  breakdown: CostBreakdown | null;
}

export interface TimelineLane {
  agentId: string;
  runs: TimelineRun[];
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostShare {
  /** An agent id or a model id, depending on the split. */
  key: string;
  cost: number;
}

export interface RunTimeline {
  /** Oldest first. */
  runs: TimelineRun[];
  totalCost: number;
  pricedCount: number;
  tokens: TokenTotals;
  /** What cache reads saved against paying the input rate for them. */
  cacheSavings: number;
  /** Sum of finished runs' wall time. */
  agentMs: number;
  /** First start to last end (or now, while a run is active). */
  elapsedMs: number;
  failedCount: number;
  cancelledCount: number;
  activeCount: number;
  /** One lane per agent, in order of first appearance. */
  lanes: TimelineLane[];
  /** Spend per agent, most expensive first. */
  costByAgent: CostShare[];
  /** Spend per model, most expensive first. */
  costByModel: CostShare[];
  /** Highest single-run cost, for scaling per-run bars. */
  maxRunCost: number;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sumBreakdown(task: AgentTask): CostBreakdown | null {
  if (!task.usage || task.usage.length === 0) return null;
  const total: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const slice of task.usage) {
    const b = estimateCostBreakdown(slice);
    total.input += b.input;
    total.output += b.output;
    total.cacheRead += b.cacheRead;
    total.cacheWrite += b.cacheWrite;
  }
  return total;
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(into: TokenTotals, usage: TaskUsageSummary): void {
  into.input += usage.input;
  into.output += usage.output;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.total += usage.tokens;
}

function sortedShares(map: Map<string, number>): CostShare[] {
  return Array.from(map, ([key, cost]) => ({ key, cost })).toSorted((a, b) => b.cost - a.cost);
}

export function toTimelineRun(task: AgentTask, nowMs: number): TimelineRun | null {
  const active = ACTIVE_STATUSES.has(task.status);
  if (!active && !TERMINAL_STATUSES.has(task.status)) return null;
  const startMs =
    parseMs(task.started_at) ?? parseMs(task.dispatched_at) ?? parseMs(task.created_at);
  if (startMs == null) return null;
  const completedMs = parseMs(task.completed_at);
  // A run cancelled before it ever started has no completion time on some
  // backends; pin it to its start so it still lands on the axis as a sliver.
  const endMs = active ? Math.max(nowMs, startMs) : Math.max(completedMs ?? startMs, startMs);
  const usage = summarizeTaskUsage(task.usage);
  return {
    task,
    startMs,
    endMs,
    active,
    durationMs: active ? null : taskDurationMs(task),
    usage,
    breakdown: usage ? sumBreakdown(task) : null,
  };
}

export function buildRunTimeline(tasks: readonly AgentTask[], nowMs: number): RunTimeline {
  const runs = tasks
    .map((task) => toTimelineRun(task, nowMs))
    .filter((run): run is TimelineRun => run !== null)
    .toSorted((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  let totalCost = 0;
  let pricedCount = 0;
  let cacheSavings = 0;
  let agentMs = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let activeCount = 0;
  let maxRunCost = 0;
  const tokens = emptyTokens();
  const laneMap = new Map<string, TimelineRun[]>();
  const agentCost = new Map<string, number>();
  const modelCost = new Map<string, number>();

  for (const run of runs) {
    if (run.usage) {
      totalCost += run.usage.cost;
      pricedCount += 1;
      cacheSavings += run.usage.cacheSavings;
      maxRunCost = Math.max(maxRunCost, run.usage.cost);
      addTokens(tokens, run.usage);
      agentCost.set(run.task.agent_id, (agentCost.get(run.task.agent_id) ?? 0) + run.usage.cost);
      // Per slice, not per run: a run that spilled from one model to another
      // has a row for each, priced at its own rate.
      for (const slice of run.task.usage ?? []) {
        if (!slice.model) continue;
        modelCost.set(slice.model, (modelCost.get(slice.model) ?? 0) + estimateCost(slice));
      }
    }
    if (run.durationMs != null) agentMs += run.durationMs;
    if (run.task.status === "failed") failedCount += 1;
    if (run.task.status === "cancelled") cancelledCount += 1;
    if (run.active) activeCount += 1;
    const lane = laneMap.get(run.task.agent_id);
    if (lane) lane.push(run);
    else laneMap.set(run.task.agent_id, [run]);
  }

  const first = runs[0];
  const lastEnd = runs.reduce((m, r) => Math.max(m, r.endMs), first?.endMs ?? nowMs);
  const elapsedMs = first ? Math.max(0, lastEnd - first.startMs) : 0;

  return {
    runs,
    totalCost,
    pricedCount,
    tokens,
    cacheSavings,
    agentMs,
    elapsedMs,
    failedCount,
    cancelledCount,
    activeCount,
    lanes: Array.from(laneMap, ([agentId, laneRuns]) => ({ agentId, runs: laneRuns })),
    costByAgent: sortedShares(agentCost),
    costByModel: sortedShares(modelCost),
    maxRunCost,
  };
}

/** Share of the tokens that were served from cache, 0–1. Null with no input side. */
export function cacheHitRate(tokens: Pick<TokenTotals, "input" | "cacheRead" | "cacheWrite">): number | null {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? tokens.cacheRead / prompt : null;
}

/**
 * Clean y-axis steps (1 / 2 / 2.5 / 5 × 10ⁿ), at most `maxCount` of them, the
 * last one at or above `max` — it doubles as the top of the scale.
 */
export function niceTicks(max: number, maxCount = 4): number[] {
  if (!(max > 0)) return [];
  const magnitude = 10 ** Math.floor(Math.log10(max / maxCount));
  // 10 × magnitude always satisfies the bound, so the fallback never fires.
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => max / s <= maxCount) ??
    10 * magnitude;
  const ticks: number[] = [];
  for (let i = 1; ; i++) {
    const v = Number((step * i).toPrecision(12));
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

export interface RunDayGroup {
  /** Local midnight of the day. */
  dayMs: number;
  /** Newest first within the day. */
  runs: TimelineRun[];
  cost: number;
  tokens: number;
  agentMs: number;
}

/** Newest day first, newest run first — the order people scan a log in. */
export function groupRunsByDay(runs: readonly TimelineRun[]): RunDayGroup[] {
  const groups = new Map<number, RunDayGroup>();
  for (const run of runs.toSorted((a, b) => b.startMs - a.startMs)) {
    const day = new Date(run.startMs);
    day.setHours(0, 0, 0, 0);
    const key = day.getTime();
    let group = groups.get(key);
    if (!group) {
      group = { dayMs: key, runs: [], cost: 0, tokens: 0, agentMs: 0 };
      groups.set(key, group);
    }
    group.runs.push(run);
    group.cost += run.usage?.cost ?? 0;
    group.tokens += run.usage?.tokens ?? 0;
    group.agentMs += run.durationMs ?? 0;
  }
  return Array.from(groups.values());
}

// ─── Model names ───────────────────────────────────────────────────────────

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A model id as a compact label: "claude-opus-5-5-high" → "Opus 5.5 high",
 * "gpt-6.1-sol" → "GPT-6.1 Sol". Provider prefixes and context-window tags
 * ("[1m]") are dropped. Ids from families it does not know come back as-is,
 * so an unfamiliar model is never renamed into something misleading.
 */
export function shortModelName(model: string): string {
  const id = model
    .replace(/^[^/]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  // claude-<tier>-<major>[-<minor>]-<variant…>
  const claude = id.match(/^claude-([a-z]+)((?:-\d{1,2})+)(?:-(.+))?$/);
  if (claude) {
    const [, tier, version, variant] = claude;
    return [capitalize(tier!), version!.slice(1).replaceAll("-", "."), variant?.replaceAll("-", " ")]
      .filter(Boolean)
      .join(" ");
  }
  // gpt-<version>-<variant…>, gemini-<version>-<variant…>
  const generic = id.match(/^(gpt|gemini)-([^-]+)(?:-(.+))?$/);
  if (generic) {
    const [, family, version, variant] = generic;
    const head = family === "gpt" ? `GPT-${version}` : `Gemini ${version}`;
    return [head, ...(variant?.split("-").map(capitalize) ?? [])].join(" ");
  }
  return model;
}
