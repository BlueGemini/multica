"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRight, Ban, ChevronRight, XCircle } from "lucide-react";
import type { AgentTask } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useActorName } from "@multica/core/workspace/hooks";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import { ActorAvatar } from "../../common/actor-avatar";
import { TranscriptButton } from "../../common/task-transcript";
import { cancellationActorLabel, cancelReasonLabel, failureReasonLabel } from "../../agents/components/tabs/task-failure";
import { Segmented } from "../../dashboard/components/dashboard-shared";
import { formatDuration } from "../../dashboard/utils";
import { useLocale, useT } from "../../i18n";
import {
  collectUnmappedModels,
  formatTokens,
  formatUsd,
  type CostBreakdown,
} from "../../runtimes/utils";
import { AttributionBadge } from "./attribution-badge";
import {
  bucketRuns,
  buildRunTimeline,
  cacheHitRate,
  groupRunsByDay,
  niceTicks,
  runIndexAt,
  shortModelName,
  timeTicks,
  type CostShare,
  type RunBucket,
  type RunBuckets,
  type RunTimeline,
  type TimelineRun,
} from "./issue-run-timeline";
import { canRetryRun, RetryRunButton } from "./retry-run-button";
import { useStatusLabel, useTriggerText } from "./task-run-labels";
import { WakeupRunLabel } from "./wakeup-source-chip";

// The issue's runs laid out in time — the surface the execution log's header
// and cost bars open.
//
// The sidebar answers "what is running and what just ran"; this answers "how
// did this issue get here": what it spent and on what, when, who asked for
// each run, and which ones were expensive. The chart on top buckets the runs
// in time (cost, tokens or agent time per bucket, over per-agent run lanes on
// the same axis); the list below is the same runs as rows, newest first — it
// is also the chart's accessible, exact-value view.
//
// Every figure comes from the same `summarizeTaskUsage` helpers the sidebar
// uses, so the total here can never disagree with the total that opened it.

// Cost categories in the order and colours the runtime usage charts stack them
// (`costStackConfig` in runtimes/components/charts/daily-cost-chart.tsx), so a
// run's split reads the same as a day's bar on the usage page.
const COST_PARTS = [
  { key: "input", swatch: "bg-chart-1" },
  { key: "output", swatch: "bg-chart-2" },
  { key: "cacheRead", swatch: "bg-chart-4" },
  { key: "cacheWrite", swatch: "bg-chart-3" },
] as const satisfies readonly { key: keyof CostBreakdown; swatch: string }[];

type CostPartKey = (typeof COST_PARTS)[number]["key"];

// Agents and models stack in the chart palette's order, most expensive first.
// The palette is one hue in steps of lightness, so past four the steps stop
// being tellable apart; the rest share the last step as "Others".
const SERIES_SWATCHES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4"] as const;
const OTHERS_SWATCH = "bg-chart-5";
const OTHERS_KEY = "__others__";

function useCostPartLabel(): (key: CostPartKey) => string {
  const { t } = useT("issues");
  return (key) => {
    switch (key) {
      case "input": return t(($) => $.runs_timeline.cost_input);
      case "output": return t(($) => $.runs_timeline.cost_output);
      case "cacheRead": return t(($) => $.runs_timeline.cost_cache_read);
      case "cacheWrite": return t(($) => $.runs_timeline.cost_cache_write);
    }
  };
}

function usePercent(): (share: number) => string {
  const locale = useLocale();
  const fmt = useMemo(
    () => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }),
    [locale],
  );
  return (share) => fmt.format(share);
}

export function IssueRunsDialog({
  open,
  onOpenChange,
  issueId,
  identifier,
  issueTitle,
  tasks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueId: string;
  identifier: string;
  issueTitle?: string;
  tasks: AgentTask[];
}) {
  const { t } = useT("issues");
  // `estimateCost` reads custom rates imperatively out of the Zustand store,
  // so nothing re-renders this dialog when the user saves a new rate. Subscribe
  // to the snapshot and carry it into every memo that prices usage — same
  // reason the runtime usage page subscribes in usage-section.tsx.
  const pricings = useCustomPricingStore((s) => s.pricings);
  // Active runs stretch to "now". The clock is re-read when the task list
  // changes or the dialog reopens rather than ticking: the bars move by
  // minutes, and a live timer already runs in the sidebar row.
  const { timeline, buckets } = useMemo(() => {
    const now = Date.now();
    const built = buildRunTimeline(tasks, now);
    return { timeline: built, buckets: bucketRuns(built, now) };
    // `pricings` re-prices on a saved custom rate; `open` re-reads the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, pricings, open]);
  // Models with no rate-table entry and no provider-reported cost: their tokens
  // are counted but their spend is not, so the totals understate reality.
  const unmapped = useMemo(
    () => collectUnmappedModels(tasks.flatMap((task) => task.usage ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pricings` changes which models are priced
    [tasks, pricings],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent's base is `sm:max-w-sm`, which a same-specificity
          `max-w-5xl` does not beat — `!` wins it, matching the transcript
          dialog. Fixed height so the chart stays put while the list scrolls. */}
      <DialogContent className="flex !h-[min(56rem,calc(100dvh-4rem))] !w-[calc(100vw-4rem)] !max-w-5xl flex-col !gap-0 overflow-hidden !p-0">
        <DialogHeader className="px-6 pt-5 pb-4">
          <DialogTitle>{t(($) => $.runs_timeline.title)}</DialogTitle>
          <DialogDescription>
            {issueTitle ? `${identifier} · ${issueTitle}` : identifier}
          </DialogDescription>
        </DialogHeader>

        {timeline.runs.length > 0 && (
          <>
            <RunStats timeline={timeline} />
            <RunActivityChart timeline={timeline} buckets={buckets} />
            {timeline.pricedCount > 0 && <CostSplit timeline={timeline} />}
            {/* `min-h-0`: the dialog is a flex column; without it this flex
                item sizes to its content and the list never scrolls. */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
              <RunDayList timeline={timeline} issueId={issueId} />
              <div className="mt-4 space-y-1 text-micro text-muted-foreground">
                {unmapped.length > 0 && (
                  <p>{t(($) => $.runs_timeline.note_unmapped, { models: unmapped.join(", ") })}</p>
                )}
                <p>{t(($) => $.runs_timeline.note_estimate)}</p>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Stats ─────────────────────────────────────────────────────────────────

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="min-w-0">
      <div aria-hidden className="text-micro font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// `formatDuration` falls back to this label only below one second.
const UNDER_A_SECOND = "0s";

function RunStats({ timeline }: { timeline: RunTimeline }) {
  const { t } = useT("issues");
  const percent = usePercent();
  const priced = timeline.pricedCount > 0;
  const hit = cacheHitRate(timeline.tokens);
  const breakdown = [
    timeline.failedCount > 0 &&
      t(($) => $.runs_timeline.count_failed, { count: timeline.failedCount }),
    timeline.cancelledCount > 0 &&
      t(($) => $.runs_timeline.count_cancelled, { count: timeline.cancelledCount }),
    timeline.activeCount > 0 &&
      t(($) => $.runs_timeline.count_active, { count: timeline.activeCount }),
  ].filter(Boolean);

  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-6">
      <Stat label={t(($) => $.runs_timeline.stat_spent)}>
        {/* Proportional figures: a standalone hero number set in tabular
            digits reads loose. "—" when nothing reported usage — never $0. */}
        <span className="text-display-sm font-semibold">
          {priced ? formatUsd(timeline.totalCost) : "—"}
        </span>
      </Stat>
      <Stat label={t(($) => $.runs_timeline.stat_tokens)}>
        <span className="text-title-sm font-medium tabular-nums">
          {priced ? formatTokens(timeline.tokens.total) : "—"}
        </span>
        {/* Cache reads are most of an agent's tokens; without the share the
            total reads as far more fresh work than it was. */}
        {priced && hit != null && (
          <span className="ml-1.5 text-caption text-muted-foreground">
            · {t(($) => $.runs_timeline.tokens_cached, { percent: percent(hit) })}
          </span>
        )}
      </Stat>
      <Stat label={t(($) => $.runs_timeline.stat_output)}>
        <span className="text-title-sm font-medium tabular-nums">
          {priced ? formatTokens(timeline.tokens.output) : "—"}
        </span>
      </Stat>
      <Stat label={t(($) => $.runs_timeline.stat_agent_time)}>
        <span className="text-title-sm font-medium">
          {formatDuration(timeline.agentMs / 1000, UNDER_A_SECOND)}
        </span>
        <span className="ml-1.5 text-caption text-muted-foreground">
          · {t(($) => $.runs_timeline.elapsed_note, {
            duration: formatDuration(timeline.elapsedMs / 1000, UNDER_A_SECOND),
          })}
        </span>
      </Stat>
      <Stat label={t(($) => $.runs_timeline.stat_runs)}>
        <span className="text-title-sm font-medium">{timeline.runs.length}</span>
        {breakdown.length > 0 && (
          <span className="ml-1.5 text-caption text-muted-foreground">
            · {breakdown.join(" · ")}
          </span>
        )}
      </Stat>
    </div>
  );
}

// ─── Chart ─────────────────────────────────────────────────────────────────

type Metric = "cost" | "tokens" | "time";

interface Series {
  key: string;
  label: string;
  swatch: string;
  value: (bucket: RunBucket) => number;
}

const PLOT_HEIGHT = 112;
// How far the pointer can miss a lane's bar and still be on it: a run a few
// seconds long draws as a 3px sliver, which nobody lands on exactly.
const HOVER_SLOP_PX = 8;
// The hover card's `max-w-72` plus its gap from the bucket. With less room
// than this to the right, the card opens on its left.
const HOVER_CARD_ROOM_PX = 298;
const HOUR_MS = 60 * 60 * 1000;

export function runBarTone(run: TimelineRun): string {
  if (run.active) return "bg-info animate-pulse";
  if (run.task.status === "failed") return "bg-destructive";
  if (run.task.status === "cancelled") return "bg-faint-foreground";
  return "bg-chart-2";
}

function swatchFor(index: number): string {
  return SERIES_SWATCHES[index] ?? OTHERS_SWATCH;
}

interface ChartHover {
  /** The moment under the pointer, clamped to the chart's domain. */
  t: number;
  /** The lane the pointer is over, if any. */
  lane?: string;
  /** The plot's rendered width, which turns pixels into time. */
  width: number;
}

function RunActivityChart({ timeline, buckets }: { timeline: RunTimeline; buckets: RunBuckets }) {
  const { t } = useT("issues");
  const locale = useLocale();
  const { getActorName } = useActorName();
  const partLabel = useCostPartLabel();
  const [metric, setMetric] = useState<Metric>("cost");
  const [d0, d1] = buckets.domain;
  const xPct = (ms: number) => ((ms - d0) / (d1 - d0)) * 100;

  const series: Series[] = useMemo(() => {
    if (metric === "tokens") {
      return COST_PARTS.map((part) => ({
        key: part.key,
        label: partLabel(part.key),
        swatch: part.swatch,
        value: (b: RunBucket) => b.tokens[part.key],
      }));
    }
    const pick = (b: RunBucket, agentId: string) => {
      const entry = b.byAgent.get(agentId);
      return metric === "cost" ? (entry?.cost ?? 0) : (entry?.agentMs ?? 0);
    };
    // Agents in cost order, then any that ran without reporting usage.
    const agentKeys = timeline.costByAgent.map((s) => s.key);
    for (const lane of timeline.lanes) {
      if (!agentKeys.includes(lane.agentId)) agentKeys.push(lane.agentId);
    }
    const named = agentKeys.slice(0, SERIES_SWATCHES.length);
    const rest = agentKeys.slice(SERIES_SWATCHES.length);
    const list: Series[] = named.map((agentId, i) => ({
      key: agentId,
      label: getActorName("agent", agentId),
      swatch: swatchFor(i),
      value: (b: RunBucket) => pick(b, agentId),
    }));
    if (rest.length > 0) {
      list.push({
        key: OTHERS_KEY,
        label: t(($) => $.runs_timeline.others),
        swatch: OTHERS_SWATCH,
        value: (b: RunBucket) => rest.reduce((sum, agentId) => sum + pick(b, agentId), 0),
      });
    }
    return list;
  }, [metric, timeline, getActorName, partLabel, t]);

  const totalOf = (b: RunBucket) =>
    metric === "cost" ? b.cost : metric === "tokens" ? b.tokens.total : b.agentMs;
  const maxValue = Math.max(0, ...buckets.buckets.map(totalOf));
  // Agent time ticks in whole hours once a bucket holds an hour, else minutes.
  const timeUnitMs = metric === "time" && maxValue < HOUR_MS ? 60_000 : HOUR_MS;
  const yTicks =
    metric === "time"
      ? niceTicks(maxValue / timeUnitMs).map((v) => v * timeUnitMs)
      : niceTicks(maxValue);
  const yMax = yTicks[yTicks.length - 1] ?? 1;
  const formatValue = (v: number) =>
    metric === "cost"
      ? formatTick(v)
      : metric === "tokens"
        ? formatTokens(v)
        : `${Number((v / timeUnitMs).toPrecision(3))}${timeUnitMs === HOUR_MS ? "h" : "m"}`;

  const ticks = timeTicks(buckets.domain);
  const [tickFormat, bucketLabel] = useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    const monthDay = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    const hour = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const dayHour = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return [
      (tick: (typeof ticks)[number]) => (tick.kind === "day" ? day.format(tick.t) : hour.format(tick.t)),
      (bucket: RunBucket) =>
        buckets.unit === "hour"
          ? dayHour.format(bucket.startMs)
          : buckets.unit === "day"
            ? day.format(bucket.startMs)
            : t(($) => $.runs_timeline.week_of, { date: monthDay.format(bucket.startMs) }),
    ] as const;
  }, [locale, buckets.unit, t]);

  // Hover layer. The pointer picks a bucket anywhere on the chart row — lane
  // labels and y scale included, so drifting a few pixels off the plot does
  // not drop the hover. Over a lane, the run under the pointer answers
  // instead. The list below carries the same figures for keyboard and
  // screen-reader users.
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartHover | null>(null);
  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const at = d0 + ((event.clientX - rect.left) / rect.width) * (d1 - d0);
    const lane = (event.target as Element).closest?.("[data-lane]")?.getAttribute("data-lane");
    setHover({ t: Math.min(Math.max(at, d0), d1 - 1), lane: lane ?? undefined, width: rect.width });
  };

  const hoverBucket = hover
    ? buckets.buckets.find((b) => hover.t >= b.startMs && hover.t < b.endMs)
    : undefined;
  const hoverRunIndex =
    hover?.lane != null
      ? runIndexAt(timeline.runs, hover.t, (HOVER_SLOP_PX / hover.width) * (d1 - d0), hover.lane)
      : -1;
  const hoveredRun = hoverRunIndex >= 0 ? timeline.runs[hoverRunIndex] : undefined;
  const anchorX = hoveredRun
    ? xPct(hoveredRun.endMs)
    : hoverBucket
      ? xPct(hoverBucket.endMs)
      : 0;
  const cardOnLeft = hover ? (anchorX / 100) * hover.width + HOVER_CARD_ROOM_PX > hover.width : false;
  const cardLeftX = hoveredRun ? xPct(hoveredRun.startMs) : hoverBucket ? xPct(hoverBucket.startMs) : 0;

  const unitLabel =
    buckets.unit === "hour"
      ? t(($) => $.runs_timeline.unit_hour)
      : buckets.unit === "day"
        ? t(($) => $.runs_timeline.unit_day)
        : t(($) => $.runs_timeline.unit_week);
  const stackLabel =
    metric === "tokens" ? t(($) => $.runs_timeline.stack_type) : t(($) => $.runs_timeline.stack_agent);

  return (
    <div className="mt-5 border-b px-6 pb-3">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          label={t(($) => $.runs_timeline.metric_label)}
          value={metric}
          onChange={setMetric}
          options={[
            { value: "cost", label: t(($) => $.runs_timeline.metric_cost) },
            { value: "tokens", label: t(($) => $.runs_timeline.metric_tokens) },
            { value: "time", label: t(($) => $.runs_timeline.metric_time) },
          ]}
        />
        <span className="text-caption text-muted-foreground">
          {unitLabel} · {stackLabel}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 rounded-xs", s.swatch)} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div
        role="img"
        aria-label={t(($) => $.runs_timeline.chart_aria, {
          count: timeline.runs.length,
          cost: formatUsd(timeline.totalCost),
        })}
        className="flex gap-3"
        onPointerMove={trackPointer}
        onPointerDown={trackPointer}
        onPointerLeave={() => setHover(null)}
      >
        {/* Lane labels, aligned with the lanes in the plot column. */}
        <div className="w-24 shrink-0" aria-hidden>
          <div style={{ height: PLOT_HEIGHT }} />
          <div className="mt-[9px]">
            {timeline.lanes.map((lane) => (
              <div key={lane.agentId} className="flex h-5 min-w-0 items-center gap-1.5">
                <ActorAvatar actorType="agent" actorId={lane.agentId} size="xs" />
                <span className="truncate text-micro text-muted-foreground">
                  {getActorName("agent", lane.agentId)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div ref={plotRef} className="relative min-w-0 flex-1">
          {/* Time gridlines run through the bars and the lanes alike. */}
          {ticks.map((tick) => (
            <span
              key={tick.t}
              aria-hidden
              className="absolute top-0 bottom-5 w-px bg-border"
              style={{ left: `${xPct(tick.t)}%` }}
            />
          ))}

          <div className="relative" style={{ height: PLOT_HEIGHT }} aria-hidden>
            {yTicks.map((v) => (
              <span
                key={v}
                className="absolute inset-x-0 h-px bg-border"
                style={{ top: `${(1 - v / yMax) * 100}%` }}
              />
            ))}
            {buckets.buckets.map((bucket) => {
              const total = totalOf(bucket);
              const left = xPct(bucket.startMs);
              const width = xPct(bucket.endMs) - left;
              const dimmed = hoverBucket && !hoveredRun && hoverBucket !== bucket;
              // Bars take the middle of their bucket, so neighbours never touch.
              const box = { left: `${left + width * 0.15}%`, width: `${width * 0.7}%` };
              if (total <= 0) {
                return (
                  <span
                    key={bucket.startMs}
                    data-bucket={bucket.startMs}
                    className="absolute bottom-0 h-0.5 rounded-full bg-border"
                    style={box}
                  />
                );
              }
              return (
                <span
                  key={bucket.startMs}
                  data-bucket={bucket.startMs}
                  className={cn(
                    "absolute bottom-0 flex flex-col-reverse gap-px overflow-hidden rounded-t-xs transition-opacity",
                    dimmed && "opacity-35",
                  )}
                  style={{ ...box, height: Math.max(2, (total / yMax) * PLOT_HEIGHT) }}
                >
                  {series.map((s) => {
                    const v = s.value(bucket);
                    return v > 0 ? (
                      <span key={s.key} className={cn("min-h-px", s.swatch)} style={{ flexGrow: v, flexBasis: 0 }} />
                    ) : null;
                  })}
                </span>
              );
            })}
          </div>

          {/* Rows, not tracks, carry `data-lane`, and they touch: moving from one
              lane to the next never crosses a gap that belongs to no lane. */}
          <div className="mt-[9px]">
            {timeline.lanes.map((lane) => (
              <div key={lane.agentId} data-lane={lane.agentId} className="py-[3px]">
                <div className="relative h-3.5 rounded-xs bg-muted/60">
                  {lane.runs.map((run) => {
                    const dimmed = hoveredRun
                      ? run !== hoveredRun
                      : hoverBucket
                        ? run.startMs < hoverBucket.startMs || run.startMs >= hoverBucket.endMs
                        : false;
                    return (
                      <span
                        key={run.task.id}
                        className={cn(
                          "absolute inset-y-0.5 min-w-[3px] rounded-xs transition-opacity",
                          runBarTone(run),
                          dimmed && "opacity-35",
                        )}
                        style={{
                          left: `${xPct(run.startMs)}%`,
                          width: `${xPct(run.endMs) - xPct(run.startMs)}%`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {hover && (hoveredRun || hoverBucket) && (
            <div
              aria-hidden
              data-hover-card
              className="pointer-events-none absolute top-0 z-20 w-max max-w-72 rounded-lg border bg-popover px-2.5 py-1.5 text-caption text-popover-foreground shadow-[var(--menu-shadow)]"
              style={{
                left: `${cardOnLeft ? cardLeftX : anchorX}%`,
                transform: cardOnLeft ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
            >
              {hoveredRun ? (
                <RunHoverCard run={hoveredRun} />
              ) : hoverBucket ? (
                <BucketHoverCard
                  bucket={hoverBucket}
                  label={bucketLabel(hoverBucket)}
                  series={series}
                  metric={metric}
                  formatValue={formatValue}
                />
              ) : null}
            </div>
          )}

          <div className="relative mt-px h-5" aria-hidden>
            {ticks.map((tick) => {
              const x = xPct(tick.t);
              return (
                <span
                  key={tick.t}
                  className="absolute top-1 whitespace-nowrap px-1 text-micro text-muted-foreground"
                  style={{ left: `${x}%`, transform: x > 92 ? "translateX(-100%)" : undefined }}
                >
                  {tickFormat(tick)}
                </span>
              );
            })}
          </div>
        </div>

        <div className="relative w-12 shrink-0 text-micro tabular-nums" style={{ height: PLOT_HEIGHT }} aria-hidden>
          {yTicks.map((v) => (
            <span
              key={v}
              className="absolute left-1 -translate-y-1/2 text-muted-foreground"
              style={{ top: `${(1 - v / yMax) * 100}%` }}
            >
              {formatValue(v)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Axis steps are round numbers; "$50.00" would print noise a tick does not need.
function formatTick(v: number): string {
  return Number.isInteger(v) ? `$${v}` : formatUsd(v);
}

function BucketHoverCard({
  bucket,
  label,
  series,
  metric,
  formatValue,
}: {
  bucket: RunBucket;
  label: string;
  series: Series[];
  metric: Metric;
  formatValue: (v: number) => string;
}) {
  const { t } = useT("issues");
  const failed = bucket.runs.filter((r) => r.task.status === "failed").length;
  const priced = bucket.runs.some((r) => r.usage);
  const facts = [
    t(($) => $.runs_timeline.day_runs, { count: bucket.runs.length }),
    failed > 0 ? t(($) => $.runs_timeline.count_failed, { count: failed }) : null,
    bucket.agentMs > 0
      ? t(($) => $.runs_timeline.bucket_agent_time, {
          duration: formatDuration(bucket.agentMs / 1000, UNDER_A_SECOND),
        })
      : null,
  ].filter(Boolean);
  const rows = series.map((s) => ({ s, v: s.value(bucket) })).filter(({ v }) => v > 0);
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <span className="font-medium">{label}</span>
      <span className="text-micro tabular-nums text-muted-foreground">{facts.join(" · ")}</span>
      {priced && (
        <span className="text-micro tabular-nums">
          <span className="font-medium">{formatUsd(bucket.cost)}</span>
          <span className="text-muted-foreground">
            {" · "}
            {t(($) => $.runs_timeline.tokens_count, { tokens: formatTokens(bucket.tokens.total) })}
          </span>
        </span>
      )}
      {metric !== "cost" || rows.length > 1
        ? rows.map(({ s, v }) => (
            <span key={s.key} className="flex items-center gap-1.5 text-micro tabular-nums">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", s.swatch)} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
              <span className="font-medium">
                {metric === "time" ? formatDuration(v / 1000, UNDER_A_SECOND) : formatValue(v)}
              </span>
            </span>
          ))
        : null}
    </div>
  );
}

/**
 * A run's trigger, with a wakeup run naming its rule's condition ("Wakeup ·
 * When a linked PR's CI finishes") the way the execution log's rows do. The
 * rule lookup mounts only for wakeup runs.
 */
export function RunTriggerLabel({
  task,
  fallback,
  children,
}: {
  task: AgentTask;
  fallback: string;
  children: (label: string) => React.ReactNode;
}) {
  if (!task.wakeup_id) return <>{children(fallback)}</>;
  return <WakeupRunLabel task={task} fallback={fallback} render={children} />;
}

function RunHoverCard({ run }: { run: TimelineRun }) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();
  const trigger = useTriggerText(run.task);
  const status = useStatusLabel(run.task.status);
  const locale = useLocale();
  const when = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(run.startMs);
  const facts = [
    when,
    run.task.status === "completed" && run.durationMs != null
      ? formatDuration(run.durationMs / 1000, UNDER_A_SECOND)
      : status,
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <RunTriggerLabel task={run.task} fallback={trigger}>
        {(label) => <span className="truncate font-medium">{label}</span>}
      </RunTriggerLabel>
      <span className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
        <ActorAvatar actorType="agent" actorId={run.task.agent_id} size="xs" />
        <span className="truncate">{[getActorName("agent", run.task.agent_id), ...facts].join(" · ")}</span>
      </span>
      <span className="text-micro tabular-nums">
        {run.usage ? (
          <>
            <span className="font-medium">{formatUsd(run.usage.cost)}</span>
            <span className="text-muted-foreground">
              {" · "}
              {t(($) => $.runs_timeline.tokens_count, { tokens: formatTokens(run.usage.tokens) })}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{t(($) => $.runs_timeline.no_usage)}</span>
        )}
      </span>
    </div>
  );
}

// ─── Cost split ────────────────────────────────────────────────────────────

function CostSplit({ timeline }: { timeline: RunTimeline }) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-3 border-b px-6 py-3 sm:grid-cols-2">
      <ShareBand
        title={t(($) => $.runs_timeline.by_agent)}
        shares={timeline.costByAgent}
        total={timeline.totalCost}
        label={(key) => getActorName("agent", key)}
      />
      <ShareBand
        title={t(($) => $.runs_timeline.by_model)}
        shares={timeline.costByModel}
        total={timeline.totalCost}
        label={shortModelName}
        hint={(key) => key}
      />
    </div>
  );
}

function ShareBand({
  title,
  shares,
  total,
  label,
  hint,
}: {
  title: string;
  shares: CostShare[];
  total: number;
  label: (key: string) => string;
  /** Native tooltip for an entry, when its label shortens the key. */
  hint?: (key: string) => string;
}) {
  const { t } = useT("issues");
  const percent = usePercent();
  const named = shares.slice(0, SERIES_SWATCHES.length);
  const rest = shares.slice(SERIES_SWATCHES.length);
  const entries = [
    ...named.map((s, i) => ({ key: s.key, name: label(s.key), hint: hint?.(s.key), cost: s.cost, swatch: swatchFor(i) })),
    ...(rest.length > 0
      ? [{
          key: OTHERS_KEY,
          name: t(($) => $.runs_timeline.others),
          hint: undefined,
          cost: rest.reduce((sum, s) => sum + s.cost, 0),
          swatch: OTHERS_SWATCH,
        }]
      : []),
  ].filter((e) => e.cost > 0);
  if (entries.length === 0) return null;

  return (
    <section aria-label={title} className="min-w-0">
      <div className="text-micro font-medium uppercase tracking-wider text-muted-foreground">{title}</div>
      <div aria-hidden className="mt-1.5 mb-1.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {entries.map((e) => (
          <span key={e.key} className={e.swatch} style={{ flexGrow: e.cost, flexBasis: 0 }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption tabular-nums text-muted-foreground">
        {entries.map((e) => (
          <span key={e.key} className="flex min-w-0 items-center gap-1.5" title={e.hint}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", e.swatch)} />
            <span className="truncate text-foreground">{e.name}</span>
            <span>{formatUsd(e.cost)}</span>
            <span className="text-faint-foreground">{percent(total > 0 ? e.cost / total : 0)}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

// ─── List ──────────────────────────────────────────────────────────────────

// Column widths shared by the header and every row.
const COL = {
  time: "w-10 shrink-0",
  attribution: "w-4 shrink-0",
  arrow: "w-3 shrink-0",
  agent: "w-24 shrink-0",
  model: "w-24 shrink-0",
  status: "w-20 shrink-0",
  tokens: "w-14 shrink-0 text-right",
  cost: "w-14 shrink-0 text-right",
  actions: "w-14 shrink-0",
  toggle: "w-6 shrink-0",
} as const;

function RunDayList({ timeline, issueId }: { timeline: RunTimeline; issueId: string }) {
  const { t } = useT("issues");
  const locale = useLocale();
  const groups = useMemo(() => groupRunsByDay(timeline.runs), [timeline.runs]);

  const dayLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return (dayMs: number) => {
      if (dayMs === today.getTime()) return t(($) => $.runs_timeline.day_today);
      if (dayMs === yesterday.getTime()) return t(($) => $.runs_timeline.day_yesterday);
      return fmt.format(dayMs);
    };
  }, [locale, t]);

  return (
    <div>
      <div
        aria-hidden
        className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b bg-popover text-micro font-medium text-muted-foreground"
      >
        <span className={COL.time}>{t(($) => $.runs_timeline.col_time)}</span>
        <span className={COL.attribution} />
        <span className="min-w-0 flex-1">{t(($) => $.runs_timeline.col_trigger)}</span>
        <span className={COL.arrow} />
        <span className={COL.agent}>{t(($) => $.runs_timeline.col_agent)}</span>
        <span className={COL.model}>{t(($) => $.runs_timeline.col_model)}</span>
        <span className={COL.status}>{t(($) => $.runs_timeline.col_duration)}</span>
        <span className={COL.tokens}>{t(($) => $.runs_timeline.col_tokens)}</span>
        <span className={COL.cost}>{t(($) => $.runs_timeline.col_cost)}</span>
        <span className={COL.actions} />
        <span className={COL.toggle} />
      </div>
      {groups.map((group) => {
        const priced = group.runs.some((r) => r.usage);
        return (
          <section key={group.dayMs} aria-label={dayLabel(group.dayMs)}>
            <div className="flex items-baseline gap-2 border-b pt-4 pb-1.5 text-micro text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground">
                {dayLabel(group.dayMs)}
              </span>
              <span className="ml-auto tabular-nums">
                {[
                  t(($) => $.runs_timeline.day_runs, { count: group.runs.length }),
                  group.agentMs > 0 ? formatDuration(group.agentMs / 1000, UNDER_A_SECOND) : null,
                  priced ? t(($) => $.runs_timeline.tokens_count, { tokens: formatTokens(group.tokens) }) : null,
                  priced ? formatUsd(group.cost) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {group.runs.map((run) => (
              <RunListRow key={run.task.id} run={run} issueId={issueId} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function useStatusReason(task: AgentTask): string | null {
  const { t: tAgents } = useT("agents");
  // Same localized reason the sidebar rows show — never the raw `task.error`,
  // which is operator-facing English (#7411).
  const reason =
    task.status === "failed"
      ? failureReasonLabel(task.failure_reason, tAgents)
      : cancelReasonLabel(task, tAgents);
  const cancelledBy = cancellationActorLabel(task, tAgents);
  return [cancelledBy, reason].filter(Boolean).join(" · ") || null;
}

function RunListRow({ run, issueId }: { run: TimelineRun; issueId: string }) {
  const { t } = useT("issues");
  const locale = useLocale();
  const { getActorName } = useActorName();
  const [expanded, setExpanded] = useState(false);
  const trigger = useTriggerText(run.task);
  const statusLabel = useStatusLabel(run.task.status);
  const reason = useStatusReason(run.task);
  const task = run.task;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(run.startMs);
  // Comment-triggered runs quote what the person said; structural triggers
  // (assignment, autopilot, retry labels) read as plain labels, and so do
  // wakeup runs, whose comment id points at the thread the rule lives in.
  const quoted = !task.wakeup_id && !!task.trigger_summary && !!task.trigger_comment_id;
  const agentName = getActorName("agent", task.agent_id);
  const label = quoted ? t(($) => $.runs_timeline.quoted, { text: trigger }) : trigger;
  const model = run.usage?.models[0];
  const detailsId = `run-details-${task.id}`;

  return (
    <div className={cn("border-b", expanded && "bg-accent/40")}>
      <div className="group/run-row flex h-9 items-center gap-2 text-caption transition-colors hover:bg-accent/40">
        <span className={cn(COL.time, "font-mono text-micro tabular-nums text-muted-foreground")}>
          {time}
        </span>
        <span className={cn(COL.attribution, "flex justify-center")}>
          <AttributionBadge attribution={task.attribution} variant="avatar" />
        </span>
        {/* One line keeps the list scannable; the full text is in the native
            tooltip and, whole and wrapped, at the top of the transcript. */}
        <RunTriggerLabel task={task} fallback={label}>
          {(text) => (
            <span
              title={text}
              className={cn(
                "min-w-0 flex-1 truncate text-label",
                run.usage || run.active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {text}
            </span>
          )}
        </RunTriggerLabel>
        <ArrowRight aria-hidden className={cn(COL.arrow, "size-3 text-faint-foreground")} />
        <span className={cn(COL.agent, "flex items-center gap-1.5")}>
          <ActorAvatar actorType="agent" actorId={task.agent_id} size="xs" enableHoverCard />
          <span className="truncate">{agentName}</span>
        </span>
        <span className={cn(COL.model, "min-w-0")}>
          {model ? (
            <span
              title={run.usage!.models.join(", ")}
              className="inline-block max-w-full truncate rounded-xs bg-muted px-1.5 py-0.5 align-middle text-micro text-muted-foreground"
            >
              {shortModelName(model)}
            </span>
          ) : (
            <span className="text-faint-foreground">—</span>
          )}
        </span>
        <span className={cn(COL.status, "flex items-center gap-1")} title={reason ?? statusLabel}>
          {run.active ? (
            <span className="flex items-center gap-1 text-info">
              <span className="size-1.5 rounded-full bg-info" />
              {statusLabel}
            </span>
          ) : task.status === "failed" ? (
            <span className="flex min-w-0 items-center gap-1 text-destructive">
              <XCircle aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{statusLabel}</span>
            </span>
          ) : task.status === "cancelled" ? (
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <Ban aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{statusLabel}</span>
            </span>
          ) : (
            <>
              <span className="tabular-nums text-muted-foreground">
                {run.durationMs != null ? formatDuration(run.durationMs / 1000, UNDER_A_SECOND) : "—"}
              </span>
              <span className="sr-only">{statusLabel}</span>
            </>
          )}
        </span>
        {run.usage ? (
          <>
            <span className={cn(COL.tokens, "tabular-nums text-muted-foreground")}>
              {formatTokens(run.usage.tokens)}
            </span>
            <span className={cn(COL.cost, "font-medium tabular-nums")}>{formatUsd(run.usage.cost)}</span>
          </>
        ) : (
          // No figure is not zero: a run without usage data was not free.
          <>
            <span className={cn(COL.tokens, "text-faint-foreground")}>—</span>
            <span className={cn(COL.cost, "text-faint-foreground")} title={t(($) => $.runs_timeline.no_usage)}>
              —
            </span>
          </>
        )}
        <span className={cn(COL.actions, "flex items-center justify-end gap-0.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/run-row:opacity-100 [@media(hover:hover)]:focus-within:opacity-100")}>
          <TranscriptButton
            task={task}
            agentName={agentName}
            isLive={task.status === "running"}
            title={t(($) => $.execution_log.transcript_tooltip)}
          />
          {canRetryRun(task) && <RetryRunButton task={task} issueId={issueId} />}
        </span>
        <span className={cn(COL.toggle, "flex justify-end")}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={t(($) => $.runs_timeline.details_toggle)}
            onClick={() => setExpanded((v) => !v)}
            className="flex size-6 items-center justify-center rounded-xs text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        </span>
      </div>
      {expanded && <RunDetails id={detailsId} run={run} reason={reason} />}
    </div>
  );
}

function RunDetails({ id, run, reason }: { id: string; run: TimelineRun; reason: string | null }) {
  const { t } = useT("issues");
  const locale = useLocale();
  const partLabel = useCostPartLabel();
  const percent = usePercent();
  const statusLabel = useStatusLabel(run.task.status);
  const usage = run.usage;
  const breakdown = run.breakdown;
  const hit = usage ? cacheHitRate(usage) : null;
  const hm = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const tokenCount: Record<CostPartKey, number> = usage
    ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const statusTone =
    run.task.status === "failed"
      ? "text-destructive"
      : run.active
        ? "text-info"
        : undefined;

  return (
    <div id={id} className="grid grid-cols-1 gap-x-8 gap-y-4 px-3 pt-2 pb-4 pl-[4.5rem] text-caption md:grid-cols-[minmax(0,1fr)_16rem]">
      {usage && breakdown ? (
        <div className="min-w-0">
          <div className="mb-2 text-micro font-medium uppercase tracking-wider text-muted-foreground">
            {t(($) => $.runs_timeline.detail_breakdown)}
          </div>
          <div aria-hidden className="mb-2.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
            {COST_PARTS.map((part) =>
              breakdown[part.key] > 0 ? (
                <span key={part.key} className={part.swatch} style={{ flexGrow: breakdown[part.key], flexBasis: 0 }} />
              ) : null,
            )}
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1 tabular-nums">
            {COST_PARTS.map((part) => (
              <RunDetailPart
                key={part.key}
                swatch={part.swatch}
                label={partLabel(part.key)}
                tokens={tokenCount[part.key]}
                cost={breakdown[part.key]}
                share={usage.cost > 0 ? percent(breakdown[part.key] / usage.cost) : ""}
              />
            ))}
            <span />
            <span className="font-medium">{t(($) => $.runs_timeline.detail_total)}</span>
            <span className="text-right font-medium">{formatTokens(usage.tokens)}</span>
            <span className="w-14 text-right font-semibold">{formatUsd(usage.cost)}</span>
            <span />
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">{t(($) => $.runs_timeline.no_usage)}</p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t(($) => $.runs_timeline.detail_status)}</dt>
        <dd className={cn("min-w-0", statusTone)}>{[statusLabel, reason].filter(Boolean).join(" · ")}</dd>
        {usage && usage.models.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t(($) => $.runs_timeline.detail_model)}</dt>
            <dd className="min-w-0 break-words">{usage.models.join(", ")}</dd>
          </>
        )}
        {usage && hit != null && (
          <>
            <dt className="text-muted-foreground">{t(($) => $.runs_timeline.detail_cache)}</dt>
            <dd className="tabular-nums">
              {t(($) => $.runs_timeline.cache_hit_value, {
                percent: percent(hit),
                amount: formatUsd(usage.cacheSavings),
              })}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t(($) => $.runs_timeline.detail_time)}</dt>
        <dd className="tabular-nums">
          {run.active ? hm.format(run.startMs) : `${hm.format(run.startMs)}–${hm.format(run.endMs)}`}
        </dd>
        {run.task.branch_name && (
          <>
            <dt className="text-muted-foreground">{t(($) => $.runs_timeline.detail_branch)}</dt>
            <dd className="min-w-0 truncate font-mono text-micro" title={run.task.branch_name}>
              {run.task.branch_name}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function RunDetailPart({
  swatch,
  label,
  tokens,
  cost,
  share,
}: {
  swatch: string;
  label: string;
  tokens: number;
  cost: number;
  share: string;
}) {
  return (
    <>
      <span aria-hidden className={cn("size-2 rounded-xs", swatch)} />
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="text-right">{formatTokens(tokens)}</span>
      <span className="w-14 text-right font-medium">{formatUsd(cost)}</span>
      <span className="w-10 text-right text-faint-foreground">{share}</span>
    </>
  );
}
