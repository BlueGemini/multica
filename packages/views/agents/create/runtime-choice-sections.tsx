"use client";

import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Cloud,
  Download,
  Laptop,
  Loader2,
  Lock,
  Monitor,
  Plus,
  Server,
  SquareTerminal,
} from "lucide-react";
import type { QoderConnection } from "@multica/core/runtimes/qoder";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { HealthDot } from "../../runtimes/components/shared";
import {
  filterDevice,
  harnessMatches,
  LOCAL_COLLAPSE_THRESHOLD,
  LOCAL_PREVIEW_COUNT,
  previewOptions,
  REMOTE_PILL_LIMIT,
  type DeviceOption,
  type HarnessOption,
} from "./runtime-choice";

export type QoderChoiceState =
  | "not_configured"
  | "starting"
  | "ready"
  | "error"
  | "stopped";

export function qoderChoiceState(
  connection: QoderConnection,
  runtimeOnline: boolean,
): QoderChoiceState {
  if (!connection.configured) return "not_configured";
  if (!connection.enabled) return "stopped";
  if (connection.status === "error") return "error";
  return runtimeOnline && connection.status === "online" ? "ready" : "starting";
}

function SectionHeader({
  icon: Icon,
  title,
  description,
  meta,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <h3 className="shrink-0 text-label font-semibold">{title}</h3>
      <span className="min-w-0 truncate text-caption text-muted-foreground">
        {description}
      </span>
      {meta ? (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const index = q ? text.toLowerCase().indexOf(q) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-xs bg-warning/25 text-inherit">
        {text.slice(index, index + q.length)}
      </mark>
      {text.slice(index + q.length)}
    </>
  );
}

function NoMatch({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-3 py-2.5 text-caption text-muted-foreground">
      {children}
    </div>
  );
}

function EmptyBlock({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{title}</p>
        <p className="mt-0.5 text-caption text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function SelectedTick({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground",
        className,
      )}
    >
      <Check className="size-2.5" />
    </span>
  );
}

function HarnessTile({
  option,
  selected,
  query,
  onSelect,
}: {
  option: HarnessOption;
  selected: boolean;
  query: string;
  onSelect: () => void;
}) {
  const { t } = useT("agents");
  const online = option.runtime.status === "online";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "relative flex min-h-[88px] flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors",
        "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-1 ring-primary hover:border-primary",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <ProviderLogo provider={option.runtime.provider} className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium">
              <Highlight text={option.label} query={query} />
            </span>
            {option.custom ? (
              <span className="shrink-0 rounded-xs bg-muted px-1 text-micro text-muted-foreground">
                {t(($) => $.creation_studio.runtime_step.custom_badge)}
              </span>
            ) : null}
          </span>
          {option.version ? (
            <span className="block truncate font-mono text-caption text-muted-foreground">
              {option.version}
            </span>
          ) : null}
        </span>
      </span>
      <span className="mt-auto flex items-center gap-1.5 text-caption text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            online ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
        {online
          ? t(($) => $.creation_studio.runtime_step.online)
          : t(($) => $.creation_studio.runtime_step.offline)}
      </span>
      {selected ? <SelectedTick className="absolute bottom-3 right-3" /> : null}
    </button>
  );
}

function CompactHarness({
  option,
  selected,
  onSelect,
}: {
  option: HarnessOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 text-left transition-colors",
        "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-1 ring-primary hover:border-primary",
      )}
    >
      <ProviderLogo provider={option.runtime.provider} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-label font-medium">
        {option.label}
      </span>
      {selected ? <SelectedTick className="shrink-0" /> : null}
    </button>
  );
}

export function LocalSection({
  device,
  available,
  starting,
  query,
  selectedRuntimeId,
  expanded,
  onToggleExpanded,
  onSelect,
  manageHref,
}: {
  device: DeviceOption | null;
  /** False on web, where no harness can run on the device in use. */
  available: boolean;
  starting: boolean;
  query: string;
  selectedRuntimeId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: (runtimeId: string) => void;
  manageHref: string | null;
}) {
  const { t } = useT("agents");
  const title = t(($) => $.creation_studio.runtime_step.sections.local.title);
  const description = t(
    ($) => $.creation_studio.runtime_step.sections.local.description,
  );

  if (!available) {
    return (
      <section>
        <SectionHeader icon={Laptop} title={title} description={description} />
        <EmptyBlock
          icon={Monitor}
          title={t(($) => $.creation_studio.runtime_step.web_local_title)}
          description={t(($) => $.creation_studio.runtime_step.web_local_hint)}
          action={
            <a
              href="/download"
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ size: "sm" })}
            >
              <Download aria-hidden="true" className="size-3.5" />
              {t(($) => $.creation_studio.runtime_step.download_desktop)}
            </a>
          }
        />
      </section>
    );
  }

  const all = device?.harnesses ?? [];
  const matched = all.filter((option) =>
    harnessMatches(option, device?.machine.title ?? "", query),
  );
  const searching = query.trim().length > 0;
  const meta = device ? (
    <>
      <Laptop aria-hidden="true" className="size-3" />
      <span className="max-w-56 truncate">{device.machine.title}</span>
      <span>·</span>
      <span>
        {searching
          ? t(($) => $.creation_studio.runtime_step.match_count, {
              count: matched.length,
            })
          : t(($) => $.creation_studio.runtime_step.harness_count, {
              count: all.length,
            })}
      </span>
    </>
  ) : null;

  let body: ReactNode;
  if (all.length === 0) {
    body = starting ? (
      <EmptyBlock
        icon={Loader2}
        title={t(($) => $.creation_studio.runtime_step.local_starting)}
        description={t(($) => $.creation_studio.runtime_step.local_empty_hint)}
      />
    ) : (
      <EmptyBlock
        icon={SquareTerminal}
        title={t(($) => $.creation_studio.runtime_step.local_empty_title)}
        description={t(($) => $.creation_studio.runtime_step.local_empty_hint)}
      />
    );
  } else if (searching && matched.length === 0) {
    body = (
      <NoMatch>
        {t(($) => $.creation_studio.runtime_step.no_match_local, { query })}
      </NoMatch>
    );
  } else if (!searching && expanded && all.length > LOCAL_COLLAPSE_THRESHOLD) {
    const builtIn = all.filter((option) => !option.custom);
    const custom = all.filter((option) => option.custom);
    body = (
      <div className="rounded-lg border bg-card p-3">
        <CompactGroup
          label={t(($) => $.creation_studio.runtime_step.group_all, {
            count: builtIn.length,
          })}
          options={builtIn}
          selectedRuntimeId={selectedRuntimeId}
          onSelect={onSelect}
        />
        {custom.length > 0 ? (
          <CompactGroup
            label={t(($) => $.creation_studio.runtime_step.group_custom, {
              count: custom.length,
            })}
            options={custom}
            selectedRuntimeId={selectedRuntimeId}
            onSelect={onSelect}
          />
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex items-center gap-1 text-caption font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(($) => $.creation_studio.runtime_step.collapse)}
            <ChevronDown aria-hidden="true" className="size-3 rotate-180" />
          </button>
          {manageHref ? (
            <AppLink
              href={manageHref}
              className="ml-auto text-caption text-muted-foreground hover:text-foreground hover:underline"
            >
              {t(($) => $.creation_studio.runtime_step.add_custom)}
            </AppLink>
          ) : null}
        </div>
      </div>
    );
  } else {
    const collapsible = !searching && all.length > LOCAL_COLLAPSE_THRESHOLD;
    const { shown, hiddenCount } = collapsible
      ? previewOptions(all, selectedRuntimeId, LOCAL_PREVIEW_COUNT)
      : { shown: matched, hiddenCount: 0 };
    body = (
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
        {shown.map((option) => (
          <HarnessTile
            key={option.runtime.id}
            option={option}
            query={query}
            selected={option.runtime.id === selectedRuntimeId}
            onSelect={() => onSelect(option.runtime.id)}
          />
        ))}
        {collapsible ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="flex min-h-[88px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/30 p-3 text-center transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-label font-medium">
              {t(($) => $.creation_studio.runtime_step.show_all, {
                count: all.length,
              })}
            </span>
            <span className="text-caption text-muted-foreground">
              {t(($) => $.creation_studio.runtime_step.show_all_hint, {
                count: hiddenCount,
              })}
            </span>
          </button>
        ) : !searching && manageHref ? (
          <AppLink
            href={manageHref}
            className="flex min-h-[88px] items-center justify-center gap-1.5 rounded-lg border border-dashed text-label text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t(($) => $.creation_studio.runtime_step.add_custom)}
          </AppLink>
        ) : null}
      </div>
    );
  }

  return (
    <section>
      <SectionHeader icon={Laptop} title={title} description={description} meta={meta} />
      {body}
    </section>
  );
}

function CompactGroup({
  label,
  options,
  selectedRuntimeId,
  onSelect,
}: {
  label: string;
  options: HarnessOption[];
  selectedRuntimeId: string | null;
  onSelect: (runtimeId: string) => void;
}) {
  return (
    <div className="mt-1 first:mt-0">
      <p className="mb-1.5 mt-2 text-micro font-medium text-muted-foreground first:mt-0">
        {label}
      </p>
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3 xl:grid-cols-4">
        {options.map((option) => (
          <CompactHarness
            key={option.runtime.id}
            option={option}
            selected={option.runtime.id === selectedRuntimeId}
            onSelect={() => onSelect(option.runtime.id)}
          />
        ))}
      </div>
    </div>
  );
}

function HarnessPill({
  option,
  selected,
  dimmed,
  query,
  onSelect,
}: {
  option: HarnessOption;
  selected: boolean;
  dimmed: boolean;
  query: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 text-label transition-colors",
        "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dimmed && "text-muted-foreground",
        selected && "border-primary ring-1 ring-primary hover:border-primary",
      )}
    >
      <ProviderLogo
        provider={option.runtime.provider}
        className={cn("size-3.5", dimmed && "opacity-60")}
      />
      <span>
        <Highlight text={option.label} query={query} />
      </span>
      {selected ? <SelectedTick /> : null}
    </button>
  );
}

export function RemoteSection({
  devices,
  hiddenCount,
  query,
  selectedRuntimeId,
  expandedMachineId,
  onExpand,
  onSelect,
  ownerName,
  onAddRemote,
}: {
  devices: DeviceOption[];
  hiddenCount: number;
  query: string;
  selectedRuntimeId: string | null;
  expandedMachineId: string | null;
  onExpand: (machineId: string | null) => void;
  onSelect: (runtimeId: string) => void;
  ownerName: (ownerId: string | null) => string | null;
  onAddRemote: () => void;
}) {
  const { t } = useT("agents");
  const title = t(($) => $.creation_studio.runtime_step.sections.remote.title);
  const description = t(
    ($) => $.creation_studio.runtime_step.sections.remote.description,
  );
  const searching = query.trim().length > 0;

  if (devices.length === 0) {
    return (
      <section>
        <SectionHeader icon={Server} title={title} description={description} />
        <EmptyBlock
          icon={Server}
          title={t(($) => $.creation_studio.runtime_step.remote_empty_title)}
          description={t(($) => $.creation_studio.runtime_step.remote_empty_hint)}
          action={
            <Button size="sm" variant="outline" onClick={onAddRemote}>
              <SquareTerminal aria-hidden="true" className="size-3.5" />
              {t(($) => $.creation_studio.runtime_step.add_remote)}
            </Button>
          }
        />
        {hiddenCount > 0 ? <HiddenNote count={hiddenCount} /> : null}
      </section>
    );
  }

  const matched = devices
    .map((device) => filterDevice(device, query))
    .filter((device): device is DeviceOption => device !== null);
  const meta = searching
    ? t(($) => $.creation_studio.runtime_step.devices_matched, {
        count: matched.length,
      })
    : t(($) => $.creation_studio.runtime_step.device_count, {
        count: devices.length,
      });

  return (
    <section>
      <SectionHeader icon={Server} title={title} description={description} meta={meta} />
      {matched.length === 0 ? (
        <NoMatch>
          {t(($) => $.creation_studio.runtime_step.no_match_remote, { query })}
        </NoMatch>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {matched.map((device) => {
            const machine = device.machine;
            const offline = machine.onlineCount === 0;
            const expanded = searching || expandedMachineId === machine.id;
            const owner = ownerName(device.harnesses[0]?.runtime.owner_id ?? null);
            const { shown, hiddenCount: rest } = expanded
              ? { shown: device.harnesses, hiddenCount: 0 }
              : previewOptions(device.harnesses, selectedRuntimeId, REMOTE_PILL_LIMIT);
            const inline = expanded && !searching && device.harnesses.length > REMOTE_PILL_LIMIT;
            const pills = (list: HarnessOption[]) =>
              list.map((option) => (
                <HarnessPill
                  key={option.runtime.id}
                  option={option}
                  query={query}
                  dimmed={offline}
                  selected={option.runtime.id === selectedRuntimeId}
                  onSelect={() => onSelect(option.runtime.id)}
                />
              ));
            return (
              <div key={machine.id}>
                <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                  <span
                    className={cn(
                      "relative flex size-8 shrink-0 items-center justify-center rounded-md border bg-background",
                      offline && "opacity-60",
                    )}
                  >
                    <Monitor aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    <HealthDot
                      health={machine.health}
                      className="absolute -bottom-0.5 -right-0.5 ring-2 ring-card"
                    />
                  </span>
                  <div className={cn("w-56 min-w-0 shrink-0", offline && "opacity-60")}>
                    <p className="truncate text-label font-medium">
                      <Highlight text={machine.title} query={query} />
                    </p>
                    <p className="truncate text-caption text-muted-foreground">
                      {[owner, machine.subtitle].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {inline ? (
                      <span className="text-caption text-muted-foreground">
                        {t(($) => $.creation_studio.runtime_step.harness_count, {
                          count: device.harnesses.length,
                        })}
                      </span>
                    ) : (
                      pills(shown)
                    )}
                    {rest > 0 ? (
                      <button
                        type="button"
                        onClick={() => onExpand(machine.id)}
                        aria-label={t(($) => $.creation_studio.runtime_step.show_all, {
                          count: device.harnesses.length,
                        })}
                        className="inline-flex h-7 items-center rounded-md bg-muted px-2 text-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        +{rest}
                      </button>
                    ) : null}
                  </div>
                  {inline ? (
                    <button
                      type="button"
                      onClick={() => onExpand(null)}
                      className="flex shrink-0 items-center gap-1 text-caption font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t(($) => $.creation_studio.runtime_step.collapse)}
                      <ChevronDown aria-hidden="true" className="size-3 rotate-180" />
                    </button>
                  ) : null}
                </div>
                {inline ? (
                  <div className="flex flex-wrap gap-1.5 px-3 pb-3 pl-14">
                    {pills(device.harnesses)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-caption text-muted-foreground">
        {searching && devices.length > matched.length ? (
          <span>
            {t(($) => $.creation_studio.runtime_step.hidden_by_search, {
              count: devices.length - matched.length,
            })}
          </span>
        ) : hiddenCount > 0 ? (
          <HiddenNote count={hiddenCount} inline />
        ) : null}
        {!searching ? (
          <button
            type="button"
            onClick={onAddRemote}
            className="ml-auto text-caption font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(($) => $.creation_studio.runtime_step.add_remote)}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function HiddenNote({ count, inline = false }: { count: number; inline?: boolean }) {
  const { t } = useT("agents");
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-caption text-muted-foreground",
        !inline && "mt-2",
      )}
    >
      <Lock aria-hidden="true" className="size-3" />
      {t(($) => $.creation_studio.runtime_step.hidden_remote, { count })}
    </span>
  );
}

const COMING_SOON = [
  { provider: "cursor", name: "Cursor Cloud Agents", vendor: "Cursor" },
  { provider: "claude", name: "Claude Managed Agents", vendor: "Anthropic" },
];

export function CloudSection({
  qoder,
  qoderState,
  qoderSelected,
  onSelectQoder,
  others,
  selectedRuntimeId,
  onSelect,
  query,
}: {
  qoder: QoderConnection | null;
  qoderState: QoderChoiceState | null;
  qoderSelected: boolean;
  onSelectQoder: () => void;
  others: HarnessOption[];
  selectedRuntimeId: string | null;
  onSelect: (runtimeId: string) => void;
  query: string;
}) {
  const { t } = useT("agents");
  const q = query.trim().toLowerCase();
  const qoderName = "Qoder Cloud Agent";
  const showQoder = !!qoder && (!q || qoderName.toLowerCase().includes(q));
  const matchedOthers = others.filter((option) => harnessMatches(option, "", query));
  const soon = COMING_SOON.filter((item) => !q || item.name.toLowerCase().includes(q));
  const empty = !showQoder && matchedOthers.length === 0 && soon.length === 0;

  return (
    <section>
      <SectionHeader
        icon={Cloud}
        title={t(($) => $.creation_studio.runtime_step.sections.cloud.title)}
        description={t(($) => $.creation_studio.runtime_step.sections.cloud.description)}
      />
      {empty ? (
        <NoMatch>
          {t(($) => $.creation_studio.runtime_step.no_match_cloud, { query })}
        </NoMatch>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
          {showQoder && qoderState ? (
            <CloudTile
              provider="qoder_cloud"
              name={qoderName}
              query={query}
              host={t(($) => $.creation_studio.runtime_step.qoder_host)}
              selected={qoderSelected}
              onSelect={onSelectQoder}
              status={<QoderStatusChip state={qoderState} />}
              hint={
                qoderState === "not_configured"
                  ? t(($) => $.creation_studio.runtime_step.qoder_connect_here)
                  : null
              }
            />
          ) : null}
          {matchedOthers.map((option) => (
            <CloudTile
              key={option.runtime.id}
              provider={option.runtime.provider}
              name={option.label}
              query={query}
              host={option.runtime.device_info || null}
              selected={option.runtime.id === selectedRuntimeId}
              onSelect={() => onSelect(option.runtime.id)}
              status={
                <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      option.runtime.status === "online"
                        ? "bg-success"
                        : "bg-muted-foreground/40",
                    )}
                  />
                  {option.runtime.status === "online"
                    ? t(($) => $.creation_studio.runtime_step.online)
                    : t(($) => $.creation_studio.runtime_step.offline)}
                </span>
              }
              hint={null}
            />
          ))}
          {soon.map((item) => (
            <div
              key={item.provider}
              aria-disabled="true"
              className="flex min-h-[88px] flex-col gap-2 rounded-lg border bg-card p-3 opacity-55"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                  <ProviderLogo provider={item.provider} className="size-4 grayscale" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-body font-medium">
                    <Highlight text={item.name} query={query} />
                  </span>
                  <span className="block truncate text-caption text-muted-foreground">
                    {t(($) => $.creation_studio.runtime_step.hosted_by, {
                      vendor: item.vendor,
                    })}
                  </span>
                </span>
              </span>
              <span className="mt-auto">
                <span className="rounded-xs bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
                  {t(($) => $.creation_studio.runtime_step.coming_soon)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CloudTile({
  provider,
  name,
  query,
  host,
  selected,
  onSelect,
  status,
  hint,
}: {
  provider: string;
  name: string;
  query: string;
  host: string | null;
  selected: boolean;
  onSelect: () => void;
  status: ReactNode;
  hint: string | null;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "relative flex min-h-[88px] flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors",
        "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-1 ring-primary hover:border-primary",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5 pr-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <ProviderLogo provider={provider} className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body font-medium">
            <Highlight text={name} query={query} />
          </span>
          {host ? (
            <span className="block truncate text-caption text-muted-foreground">{host}</span>
          ) : null}
        </span>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-2">
        {status}
        {hint ? (
          <span className="ml-auto truncate text-caption text-faint-foreground">{hint}</span>
        ) : null}
      </span>
      {selected ? <SelectedTick className="absolute right-3 top-3" /> : null}
    </button>
  );
}

export function QoderStatusChip({ state }: { state: QoderChoiceState }) {
  const { t } = useT("agents");
  const tone =
    state === "ready"
      ? "bg-success/10 text-success"
      : state === "error"
        ? "bg-destructive/10 text-destructive"
        : state === "not_configured" || state === "starting"
          ? "bg-warning/10 text-warning"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5 text-micro font-medium",
        tone,
      )}
    >
      {state === "starting" ? (
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
      ) : null}
      {t(($) => $.creation_studio.runtime_step.qoder_status[state])}
    </span>
  );
}
