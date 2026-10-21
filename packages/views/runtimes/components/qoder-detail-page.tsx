"use client";

import { useState } from "react";
import { AlertCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useWorkspacePresenceMap } from "@multica/core/agents";
import { isRuntimeUsableForUser } from "@multica/core/runtimes";
import { runtimeListOptions } from "@multica/core/runtimes/queries";
import {
  QODER_REGIONS,
  qoderOptions,
  useDisconnectQoder,
  useSaveQoder,
  useStopQoder,
  type QoderConnection,
} from "@multica/core/runtimes/qoder";
import {
  agentListOptions,
  memberListOptions,
} from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { cn } from "@multica/ui/lib/utils";
import { PAGE_GUTTER, PAGE_RAIL } from "../../layout/page-header";
import { AppLink, useNavigation } from "../../navigation";
import { createPathWithParams } from "../../agents/create/squad-param";
import { useT } from "../../i18n";
import { ProviderLogo } from "./provider-logo";
import { QoderConfiguration } from "./qoder-configuration";
import { QoderStatusBadge } from "./qoder-status-badge";
import { ServingAgentsCard } from "./runtime-detail";
import { UsageSection } from "./usage-section";
import { parseActiveAgentsConflict } from "./delete-runtime-dialog";

/** Route locator of the workspace's Qoder Cloud Agent page. */
export const QODER_RUNTIME_LOCATOR = "qoder";

/**
 * Whether a runtimes route locator names Qoder: its own locator, the machine
 * id its runtime registers under, or the id of a Qoder runtime.
 */
export function isQoderLocator(
  locator: string,
  runtimes: AgentRuntime[],
): boolean {
  return (
    locator === QODER_RUNTIME_LOCATOR ||
    locator.startsWith("cloud:qoder-managed-") ||
    runtimes.some(
      (runtime) => runtime.id === locator && runtime.provider === "qoder_cloud",
    )
  );
}

/**
 * The workspace's Qoder Cloud Agent: one shared connection, so the page
 * manages the connection directly instead of listing harnesses on a machine.
 */
export function QoderDetailPage() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const connection = useQuery(qoderOptions(wsId));
  const { data: runtimes = [], isLoading: runtimesLoading } = useQuery(
    runtimeListOptions(wsId),
  );
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { byAgent: presenceMap } = useWorkspacePresenceMap(wsId);

  if (connection.isPending || runtimesLoading) return <QoderPageSkeleton />;
  const data = connection.data;
  if (connection.isError || data?.available !== true) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <AlertCircle aria-hidden="true" className="size-8 text-destructive" />
        <p className="max-w-md text-body">
          {connection.isError
            ? connection.error.message
            : t(($) => $.qoder.unavailable)}
        </p>
        <Button
          size="sm"
          render={<AppLink href={paths.runtimes()} />}
          nativeButton={false}
        >
          {t(($) => $.detail.all_runtimes)}
        </Button>
      </div>
    );
  }

  const member = members.find((m) => m.user_id === userId);
  const isAdmin = member?.role === "owner" || member?.role === "admin";
  const qoderRuntimes = runtimes.filter(
    (runtime) => runtime.provider === "qoder_cloud",
  );
  const runtime =
    qoderRuntimes.find((item) => item.status === "online") ??
    qoderRuntimes[0] ??
    null;
  const boundAgents = agents.filter(
    (agent) =>
      !agent.archived_at &&
      qoderRuntimes.some((item) => item.id === agent.runtime_id),
  );
  const ready =
    data.configured &&
    data.enabled &&
    data.status === "online" &&
    runtime?.status === "online";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <QoderHeader
        data={data}
        agentCount={boundAgents.length}
        action={
          ready && runtime ? (
            <Button
              size="sm"
              onClick={() =>
                navigation.push(
                  createPathWithParams(paths.newAgentManual(), {
                    runtime: runtime.id,
                  }),
                )
              }
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {t(($) => $.qoder.create_agent)}
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-background">
        <div
          className={cn(
            PAGE_RAIL,
            PAGE_GUTTER,
            "grid grid-cols-1 gap-4 py-4 sm:py-6 lg:grid-cols-[minmax(0,1fr)_320px]",
          )}
        >
          <div className="min-w-0 space-y-5">
            {runtime && isRuntimeUsableForUser(runtime, userId) && (
              <UsageSection runtime={runtime} />
            )}
            <section className="rounded-lg border bg-card">
              <h2 className="border-b px-4 py-2.5 text-caption font-semibold">
                {t(($) => $.qoder.page.configuration)}
              </h2>
              <div className="p-4">
                {data.configured || isAdmin ? (
                  <QoderConfiguration />
                ) : (
                  <div className="py-6 text-center">
                    <p className="text-body font-medium">
                      {t(($) => $.qoder.page.not_connected_title)}
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {t(($) => $.qoder.page.not_connected_hint)}
                    </p>
                  </div>
                )}
              </div>
            </section>
            {isAdmin && data.configured && (
              <DangerZone
                wsId={wsId}
                data={data}
                boundAgents={boundAgents}
                onDisconnected={() => {
                  navigation.replace(paths.runtimes());
                  toast.success(t(($) => $.qoder.disconnect_confirm.done));
                }}
              />
            )}
          </div>
          <div className="space-y-4">
            <ServingAgentsCard
              agents={boundAgents}
              presenceMap={presenceMap}
              agentHref={(id) => paths.agentDetail(id)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function QoderHeader({
  data,
  agentCount,
  action,
}: {
  data: QoderConnection;
  agentCount: number;
  action: React.ReactNode;
}) {
  const { t } = useT("runtimes");
  const paths = useWorkspacePaths();
  const title = t(($) => $.qoder.cloud_title);
  const region =
    data.baseUrl === QODER_REGIONS.cn
      ? t(($) => $.qoder.region_cn)
      : t(($) => $.qoder.region_global);
  const failing = data.enabled && data.status === "error" && !!data.lastError;
  return (
    <header className="shrink-0 border-b bg-background pb-5 pt-3">
      <div className={cn(PAGE_RAIL, PAGE_GUTTER)}>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
          <AppLink
            href={paths.runtimes()}
            className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(($) => $.page.title)}
          </AppLink>
          <span aria-hidden="true">/</span>
          <span className="truncate text-foreground">{title}</span>
        </div>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card sm:size-14">
              <ProviderLogo provider="qoder_cloud" className="size-6" />
            </div>
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="min-w-0 text-balance text-title-lg font-semibold tracking-tight sm:text-display-sm">
                  {title}
                </h1>
                <QoderStatusBadge connection={data} />
              </div>
              <p
                role={failing ? "alert" : undefined}
                className={cn(
                  "mt-1 text-body",
                  failing ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {failing
                  ? data.lastError
                  : t(($) => $.page.rows.provided_by, { vendor: "Qoder" })}
              </p>
              {data.configured && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground">
                  <span>{region}</span>
                  <span>
                    {t(($) => $.qoder.agent_count, { count: agentCount })}
                  </span>
                  <span className="tabular-nums">
                    {data.enabled && data.status === "online"
                      ? t(($) => $.qoder.usage, {
                          active: data.activeRuns,
                          limit: data.maxConcurrency,
                          queued: data.queuedRuns,
                        })
                      : t(($) => $.qoder.page.workload_idle)}
                  </span>
                </div>
              )}
            </div>
          </div>
          {action && (
            <div className="flex shrink-0 items-center gap-2 self-end lg:self-start">
              {action}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function DangerZone({
  wsId,
  data,
  boundAgents,
  onDisconnected,
}: {
  wsId: string;
  data: QoderConnection;
  boundAgents: Agent[];
  onDisconnected: () => void;
}) {
  const { t } = useT("runtimes");
  const stop = useStopQoder(wsId);
  const save = useSaveQoder(wsId);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const busy = stop.isPending || save.isPending;

  const resume = () =>
    save.mutate(
      {
        name: data.name || t(($) => $.qoder.cloud_title),
        baseUrl: data.baseUrl || QODER_REGIONS.global,
        environmentId: data.environmentId,
        qoderToken: "",
        maxConcurrency: data.maxConcurrency,
        runTimeoutMinutes: data.runTimeoutMinutes,
      },
      {
        onSuccess: () => toast.success(t(($) => $.qoder.page.resumed)),
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <section className="rounded-lg border border-destructive/30 bg-card">
      <h2 className="border-b border-destructive/20 px-4 py-2.5 text-caption font-semibold text-destructive">
        {t(($) => $.qoder.page.danger_title)}
      </h2>
      <div className="divide-y">
        {data.enabled ? (
          <DangerRow
            title={t(($) => $.qoder.page.pause_title)}
            hint={t(($) => $.qoder.page.pause_hint)}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setPauseOpen(true)}
            >
              {t(($) => $.qoder.stop)}
            </Button>
          </DangerRow>
        ) : (
          <DangerRow
            title={t(($) => $.qoder.page.resume_title)}
            hint={t(($) => $.qoder.page.resume_hint)}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-busy={save.isPending}
              onClick={resume}
            >
              {t(($) => $.qoder.page.resume)}
            </Button>
          </DangerRow>
        )}
        <DangerRow
          title={t(($) => $.qoder.page.disconnect_title)}
          hint={t(($) => $.qoder.page.disconnect_hint)}
        >
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => setDisconnectOpen(true)}
          >
            {t(($) => $.qoder.page.disconnect)}
          </Button>
        </DangerRow>
      </div>

      <AlertDialog
        open={pauseOpen}
        onOpenChange={(open) => {
          if (!open && !stop.isPending) setPauseOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.qoder.stop_confirm.title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {boundAgents.length > 0
                ? t(($) => $.qoder.stop_confirm.description_agents, {
                    count: boundAgents.length,
                  })
                : t(($) => $.qoder.stop_confirm.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AgentNames agents={boundAgents} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stop.isPending}>
              {t(($) => $.qoder.stop_confirm.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={stop.isPending}
              onClick={() =>
                stop.mutate(undefined, {
                  onError: (err) => toast.error(err.message),
                  onSettled: () => setPauseOpen(false),
                })
              }
            >
              {t(($) => $.qoder.stop)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {disconnectOpen && (
        <DisconnectQoderDialog
          wsId={wsId}
          agents={boundAgents}
          onClose={() => setDisconnectOpen(false)}
          onDisconnected={onDisconnected}
        />
      )}
    </section>
  );
}

function DangerRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-body font-medium">{title}</p>
        <p className="mt-0.5 text-pretty text-caption text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AgentNames({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) return null;
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md bg-muted/60 px-3 py-2 text-caption">
      {agents.map((agent) => (
        <li key={agent.id} className="truncate">
          {agent.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirms the agents that lose their runtime. The server refuses when that
 * set changed since the dialog opened; the dialog then shows the new set and
 * asks again.
 */
export function DisconnectQoderDialog({
  wsId,
  agents,
  onClose,
  onDisconnected,
}: {
  wsId: string;
  agents: Agent[];
  onClose: () => void;
  onDisconnected: () => void;
}) {
  const { t } = useT("runtimes");
  const disconnect = useDisconnectQoder(wsId);
  const [planAgents, setPlanAgents] = useState(agents);
  const [notice, setNotice] = useState<string | null>(null);

  const confirm = () =>
    disconnect.mutate(
      planAgents.map((agent) => agent.id),
      {
        onSuccess: onDisconnected,
        onError: (err) => {
          const conflict = parseActiveAgentsConflict(err);
          if (conflict?.code === "runtime_delete_plan_changed") {
            setPlanAgents(conflict.activeAgents);
            setNotice(t(($) => $.qoder.disconnect_confirm.plan_changed));
            return;
          }
          toast.error(err.message);
        },
      },
    );

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !disconnect.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(($) => $.qoder.disconnect_confirm.title)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.qoder.disconnect_confirm.description)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {planAgents.length > 0 && (
          <div className="space-y-2">
            <p className="text-caption text-muted-foreground">
              {t(($) => $.qoder.disconnect_confirm.description_agents, {
                count: planAgents.length,
              })}
            </p>
            <AgentNames agents={planAgents} />
          </div>
        )}
        {notice && (
          <p role="alert" className="text-caption text-warning">
            {notice}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={disconnect.isPending}>
            {t(($) => $.qoder.disconnect_confirm.cancel)}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disconnect.isPending}
            aria-busy={disconnect.isPending}
            onClick={confirm}
          >
            {disconnect.isPending
              ? t(($) => $.qoder.disconnect_confirm.working)
              : t(($) => $.qoder.disconnect_confirm.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function QoderPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b pb-5 pt-3">
        <div className={cn(PAGE_RAIL, PAGE_GUTTER)}>
          <Skeleton className="h-3 w-36" />
          <div className="mt-4 flex items-start gap-4">
            <Skeleton className="size-14 rounded-xl" />
            <div className="flex-1">
              <Skeleton className="h-7 w-64" />
              <Skeleton className="mt-2 h-4 w-40" />
            </div>
          </div>
        </div>
      </div>
      <div className={cn(PAGE_RAIL, PAGE_GUTTER, "py-6")}>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}
