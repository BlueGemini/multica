"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentBuilderSessionListOptions } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { qoderOptions } from "@multica/core/runtimes/qoder";
import { runtimeKeys, runtimeListOptions } from "@multica/core/runtimes/queries";
import { useWSEvent } from "@multica/core/realtime";
import { memberListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useBackOrReplace, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { ConnectRemoteDialog } from "../../runtimes/components/connect-remote-dialog";
import { RemoteRuntimeDialog } from "../../runtimes/components/remote-runtime-dialog";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";
import { AgentCreateShell } from "./create-shell";
import { buildRuntimeChoiceGroups, type HarnessOption } from "./runtime-choice";
import { HarnessPanel, IntroPanel, QoderPanel } from "./runtime-choice-panel";
import {
  CloudSection,
  LocalSection,
  RemoteSection,
  qoderChoiceState,
} from "./runtime-choice-sections";
import { createPathWithParams } from "./squad-param";
import { UnfinishedDraftsBanner } from "./unfinished-drafts";

type Selection = { kind: "runtime"; runtimeId: string } | { kind: "qoder" } | null;

/** How often a pending Qoder runtime is re-fetched while this screen waits on it. */
const QODER_REGISTER_POLL_MS = 3_000;

export interface ChooseRuntimePageProps {
  /** Desktop-only: the daemon running on this device. */
  localDaemonId?: string | null;
  localMachineName?: string | null;
  /** Desktop-only: this device can run harnesses, even before any registered. */
  hasLocalMachine?: boolean;
  /** The bundled daemon is starting and has not registered yet. */
  bootstrapping?: boolean;
}

/**
 * Step 1 of agent creation: where the agent runs. Everything after this step
 * depends on the answer (which models exist, whether skills apply), so the
 * runtime is chosen before anything is typed.
 */
export function ChooseRuntimePage({
  localDaemonId = null,
  localMachineName = null,
  hasLocalMachine = false,
  bootstrapping = false,
}: ChooseRuntimePageProps = {}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const backOrReplace = useBackOrReplace();
  const squadId = navigation.searchParams.get("squad");
  const runtimeParam = navigation.searchParams.get("runtime");
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);

  const { data: runtimes = [], isLoading: runtimesLoading } = useQuery(
    runtimeListOptions(wsId),
  );
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: qoderConnection } = useQuery(qoderOptions(wsId));
  const { data: sessions = [] } = useQuery(agentBuilderSessionListOptions(wsId));

  useWSEvent("daemon:register", () => {
    void qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
  });

  const groups = useMemo(() => {
    const machines = buildRuntimeMachines(runtimes, {
      now: Date.now(),
      localDaemonId,
      localMachineName,
      currentUserId,
      ensureLocalMachine: hasLocalMachine,
    });
    return buildRuntimeChoiceGroups(machines, currentUserId);
  }, [runtimes, localDaemonId, localMachineName, currentUserId, hasLocalMachine]);

  const member = members.find((m) => m.user_id === currentUserId);
  const canManage = member?.role === "owner" || member?.role === "admin";
  const admins = members
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.name);
  const ownerName = (ownerId: string | null) =>
    members.find((m) => m.user_id === ownerId)?.name ?? null;

  const qoder = qoderConnection?.available ? qoderConnection : null;
  const qoderRuntime = groups.qoderRuntime;
  const qoderState = qoder
    ? qoderChoiceState(qoder, qoderRuntime?.status === "online")
    : null;

  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [localExpanded, setLocalExpanded] = useState(false);
  const [expandedRemoteId, setExpandedRemoteId] = useState<string | null>(null);
  const [waitingForQoder, setWaitingForQoder] = useState(false);
  const [showConnectRemote, setShowConnectRemote] = useState(false);
  const [showQoderSettings, setShowQoderSettings] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const byId = new Map<string, { option: HarnessOption; section: "local" | "remote" | "cloud" }>();
    for (const option of groups.local?.harnesses ?? []) {
      byId.set(option.runtime.id, { option, section: "local" });
    }
    for (const device of groups.remotes) {
      for (const option of device.harnesses) {
        byId.set(option.runtime.id, { option, section: "remote" });
      }
    }
    for (const option of groups.cloud) {
      byId.set(option.runtime.id, { option, section: "cloud" });
    }
    return byId;
  }, [groups]);

  // `?runtime=` comes back from step 2's "change runtime" and from the Qoder
  // card on the runtimes page; it preselects once the list can resolve it.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || runtimesLoading) return;
    seeded.current = true;
    if (!runtimeParam) return;
    if (qoderRuntime?.id === runtimeParam) setSelection({ kind: "qoder" });
    else if (options.has(runtimeParam)) {
      setSelection({ kind: "runtime", runtimeId: runtimeParam });
    }
  }, [runtimeParam, runtimesLoading, options, qoderRuntime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selected =
    selection?.kind === "runtime" ? options.get(selection.runtimeId) ?? null : null;
  const nextRuntimeId =
    selection?.kind === "qoder"
      ? qoderState === "ready"
        ? qoderRuntime?.id ?? null
        : null
      : selected && selected.option.runtime.status === "online"
        ? selected.option.runtime.id
        : null;

  const goNext = (runtimeId: string) =>
    navigation.push(
      createPathWithParams(paths.newAgentManual(), {
        squad: squadId,
        runtime: runtimeId,
      }),
    );

  // A connection saved from this screen registers its runtime asynchronously;
  // poll until it lands and then continue on the member's behalf.
  useEffect(() => {
    if (!waitingForQoder) return;
    if (qoderState === "ready" && qoderRuntime) {
      setWaitingForQoder(false);
      goNext(qoderRuntime.id);
      return;
    }
    if (qoderState === "error") {
      setWaitingForQoder(false);
      return;
    }
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
    }, QODER_REGISTER_POLL_MS);
    return () => clearInterval(timer);
    // goNext is recreated each render; the effect only reacts to state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForQoder, qoderState, qoderRuntime, qc, wsId]);

  const resumeSession = (sessionId: string) =>
    navigation.push(
      createPathWithParams(paths.newAgentAiSession(sessionId), { squad: squadId }),
    );

  const selectRuntime = (runtimeId: string) =>
    setSelection((current) =>
      current?.kind === "runtime" && current.runtimeId === runtimeId
        ? null
        : { kind: "runtime", runtimeId },
    );

  const summary = (() => {
    if (selection?.kind === "qoder") return "Qoder Cloud Agent";
    if (!selected) return null;
    const sectionTitle =
      selected.section === "local"
        ? t(($) => $.creation_studio.runtime_step.sections.local.title)
        : selected.section === "cloud"
          ? t(($) => $.creation_studio.runtime_step.sections.cloud.title)
          : groups.remotes.find((device) =>
              device.harnesses.some((h) => h.runtime.id === selected.option.runtime.id),
            )?.machine.title ?? "";
    return `${selected.option.label} · ${sectionTitle}`;
  })();

  const panel = (() => {
    if (selection?.kind === "qoder" && qoder && qoderState) {
      return (
        <QoderPanel
          wsId={wsId}
          connection={qoder}
          state={waitingForQoder && qoderState !== "error" ? "starting" : qoderState}
          canManage={canManage}
          admins={admins}
          waiting={waitingForQoder}
          onConnected={() => setWaitingForQoder(true)}
          onOpenSettings={() => setShowQoderSettings(true)}
          onClearSelection={() => setSelection(null)}
        />
      );
    }
    if (selected) {
      const runtime = selected.option.runtime;
      const machine =
        selected.section === "local"
          ? groups.local?.machine ?? null
          : groups.remotes.find((device) =>
              device.harnesses.some((h) => h.runtime.id === runtime.id),
            )?.machine ?? null;
      return (
        <HarnessPanel
          option={selected.option}
          machine={machine}
          isLocal={selected.section === "local"}
          owner={ownerName(runtime.owner_id)}
          ownerIsMe={runtime.owner_id === currentUserId}
        />
      );
    }
    return <IntroPanel />;
  })();

  return (
    <AgentCreateShell
      title={
        squadId
          ? t(($) => $.creation_studio.squad_title)
          : t(($) => $.creation_studio.title)
      }
      step={t(($) => $.creation_studio.steps.runtime)}
      stepIndex={1}
      onBack={() => backOrReplace(paths.agents())}
      closeIcon
    >
      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:overflow-hidden">
        <main className="min-w-0 lg:overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-balance text-title font-semibold tracking-tight">
                  {t(($) => $.creation_studio.runtime_step.title)}
                </h2>
                <p className="mt-1 text-body text-muted-foreground">
                  {t(($) => $.creation_studio.runtime_step.description)}
                </p>
              </div>
              <div className="relative w-full sm:w-60">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setQuery("");
                  }}
                  placeholder={t(($) => $.creation_studio.runtime_step.search_placeholder)}
                  aria-label={t(($) => $.creation_studio.runtime_step.search_placeholder)}
                  className="h-8 pl-8 pr-8"
                />
                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-xs border bg-muted px-1 text-micro text-muted-foreground">
                  /
                </kbd>
              </div>
            </div>

            {sessions.length > 0 ? (
              <div className="mt-6">
                <UnfinishedDraftsBanner sessions={sessions} onResume={resumeSession} />
              </div>
            ) : null}

            <div className="mt-8 space-y-9">
              <LocalSection
                device={groups.local}
                available={hasLocalMachine}
                starting={bootstrapping}
                query={query}
                selectedRuntimeId={selection?.kind === "runtime" ? selection.runtimeId : null}
                expanded={localExpanded}
                onToggleExpanded={() => setLocalExpanded((value) => !value)}
                onSelect={selectRuntime}
                manageHref={
                  groups.local ? paths.runtimeDetail(groups.local.machine.id) : null
                }
              />
              <RemoteSection
                devices={groups.remotes}
                hiddenCount={groups.hiddenRemoteCount}
                query={query}
                selectedRuntimeId={selection?.kind === "runtime" ? selection.runtimeId : null}
                expandedMachineId={expandedRemoteId}
                onExpand={setExpandedRemoteId}
                onSelect={selectRuntime}
                ownerName={ownerName}
                onAddRemote={() => setShowConnectRemote(true)}
              />
              <CloudSection
                qoder={qoder}
                qoderState={qoderState}
                qoderSelected={selection?.kind === "qoder"}
                onSelectQoder={() =>
                  setSelection((current) => (current?.kind === "qoder" ? null : { kind: "qoder" }))
                }
                others={groups.cloud}
                selectedRuntimeId={selection?.kind === "runtime" ? selection.runtimeId : null}
                onSelect={selectRuntime}
                query={query}
              />
            </div>
          </div>
        </main>
        <aside
          aria-label={t(($) => $.creation_studio.runtime_step.panel_label)}
          className="flex min-w-0 flex-col border-t bg-muted/20 lg:overflow-y-auto lg:border-l lg:border-t-0"
        >
          {panel}
        </aside>
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-t bg-background px-5 py-3">
        <p className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {summary ? (
            <>
              {t(($) => $.creation_studio.runtime_step.footer_selected)}{" "}
              <span className="font-medium text-foreground">{summary}</span>
            </>
          ) : (
            t(($) => $.creation_studio.runtime_step.footer_hint)
          )}
        </p>
        <Button variant="ghost" onClick={() => backOrReplace(paths.agents())}>
          {t(($) => $.creation_studio.runtime_step.cancel)}
        </Button>
        <Button disabled={!nextRuntimeId} onClick={() => nextRuntimeId && goNext(nextRuntimeId)}>
          {t(($) => $.creation_studio.runtime_step.next)}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
      </footer>
      {showConnectRemote ? (
        <ConnectRemoteDialog onClose={() => setShowConnectRemote(false)} />
      ) : null}
      {showQoderSettings ? (
        <RemoteRuntimeDialog configure onClose={() => setShowQoderSettings(false)} />
      ) : null}
    </AgentCreateShell>
  );
}
