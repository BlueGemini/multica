"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentDraftKeys,
  agentDraftOptions,
  diffAgentDraftConfig,
  fromAgentDraftConfig,
  mergeRemoteAgentDraft,
  toAgentDraftConfig,
  type AgentDraft,
} from "@multica/core/agents";
import { api, ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import type { AgentDraftConfig, AgentDraftRecord } from "@multica/core/types";

const SAVE_DEBOUNCE_MS = 700;

// Fields the form fills in on its own (the runtime seed and what a runtime
// change clears). A change to only these is not the user starting a draft, so
// it must not put an empty draft on their pending list.
const AUTOMATIC_FIELDS = new Set<keyof AgentDraftConfig>([
  "runtime_id",
  "model",
  "thinking_level",
  "service_tier",
]);

export type AgentDraftSaveState = "idle" | "saving" | "saved" | "error";

/**
 * Keeps the editable draft and its server copy in step.
 *
 * An existing draft hydrates the form once, then saves only the fields the
 * user changed — the server merges per field, so a member and an agent editing
 * different fields do not overwrite each other. A newer server copy (another
 * author, through the realtime refetch) is folded in for every field the user
 * has not touched.
 *
 * A new form gets a server draft only once the user has actually entered
 * something, or asks for one with `flush({ force: true })`.
 */
export function useAgentDraftSync({
  draftId: initialDraftId,
  draft,
  setDraft,
  ready,
  onDraftCreated,
}: {
  draftId: string | null;
  draft: AgentDraft;
  setDraft: Dispatch<SetStateAction<AgentDraft>>;
  /** False while the form is still being seeded (a duplicate waiting on the
   *  runtime list); nothing is compared or saved until it flips. */
  ready: boolean;
  onDraftCreated?: (id: string) => void;
}) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [hydrated, setHydrated] = useState(initialDraftId === null);
  const [saveState, setSaveState] = useState<AgentDraftSaveState>("idle");

  const query = useQuery(agentDraftOptions(wsId, draftId ?? ""));
  const record: AgentDraftRecord | null =
    draftId && query.data?.id === draftId ? query.data : null;
  const closed = record !== null && record.status !== "pending";

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  // The last server copy the form has seen, and its version.
  const baseRef = useRef<AgentDraftConfig | null>(null);
  const versionRef = useRef<number | null>(null);
  // What a new form looked like once seeded, so "has the user entered
  // anything" ignores the seed itself.
  const pristineRef = useRef<AgentDraftConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef<Promise<string | null> | null>(null);
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const onDraftCreatedRef = useRef(onDraftCreated);
  onDraftCreatedRef.current = onDraftCreated;

  useEffect(() => {
    if (!record || record.version === versionRef.current) return;
    const previousBase = baseRef.current;    if (previousBase === null) {
      setDraft(fromAgentDraftConfig(record.config));
      setHydrated(true);
    } else {
      setDraft((current) =>
        mergeRemoteAgentDraft(current, previousBase, record.config),
      );
    }
    baseRef.current = record.config;
    versionRef.current = record.version;
  }, [record, setDraft]);

  useEffect(() => {
    if (ready && draftId === null && pristineRef.current === null) {
      pristineRef.current = toAgentDraftConfig(draft);
    }
  }, [draft, draftId, ready]);

  const save = useCallback(
    async (force: boolean): Promise<string | null> => {
      if (inflightRef.current) await inflightRef.current;
      if (closedRef.current) return draftIdRef.current;
      const config = toAgentDraftConfig(draftRef.current);
      const id = draftIdRef.current;
      const run = async (): Promise<string | null> => {
        if (id) {
          const base = baseRef.current;
          if (!base) return id;
          const changed = diffAgentDraftConfig(base, config);
          if (Object.keys(changed).length === 0) return id;
          setSaveState("saving");
          const saved = await api.updateAgentDraft(id, changed);
          baseRef.current = { ...base, ...changed };
          qc.setQueryData(agentDraftKeys.detail(wsId, id), saved);
          setSaveState("saved");
          return id;
        }
        const pristine = pristineRef.current ?? config;
        const entered = Object.keys(diffAgentDraftConfig(pristine, config)).some(
          (key) => !AUTOMATIC_FIELDS.has(key as keyof AgentDraftConfig),
        );
        if (!force && !entered) return null;
        setSaveState("saving");
        const created = await api.createAgentDraft(config);
        if (!created.id) throw new Error("agent draft create returned no id");
        baseRef.current = created.config;
        versionRef.current = created.version;
        qc.setQueryData(agentDraftKeys.detail(wsId, created.id), created);
        draftIdRef.current = created.id;
        setDraftId(created.id);
        setHydrated(true);
        setSaveState("saved");
        void qc.invalidateQueries({ queryKey: agentDraftKeys.pending(wsId) });
        onDraftCreatedRef.current?.(created.id);
        return created.id;
      };

      const pending = run().catch((error: unknown) => {
        setSaveState("error");
        // 409: the draft was created or discarded elsewhere. Refetch so the
        // form shows that instead of retrying a save that can never land.
        if (error instanceof ApiError && error.status === 409 && id) {
          void qc.invalidateQueries({
            queryKey: agentDraftKeys.detail(wsId, id),
          });
        }
        throw error;
      });
      inflightRef.current = pending;
      try {
        return await pending;
      } finally {
        if (inflightRef.current === pending) inflightRef.current = null;
      }
    },
    [qc, wsId],
  );

  const cancelPending = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Closing the editor must not drop the last keystrokes the debounce is
  // holding. Declared before the debounce effect so its cleanup runs first,
  // while the scheduled save is still visible.
  const readyRef = useRef(ready && hydrated);
  readyRef.current = ready && hydrated;
  useEffect(
    () => () => {
      if (!timerRef.current || !readyRef.current) return;
      cancelPending();
      void save(false).catch(() => {});
    },
    [cancelPending, save],
  );

  useEffect(() => {
    if (!ready || !hydrated || closed) return;
    cancelPending();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(false).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    return cancelPending;
  }, [cancelPending, closed, draft, hydrated, ready, save]);

  /** Saves now. `force` creates a server draft even for an untouched form —
   *  for "finish later" and handing the draft to an agent. */
  const flush = useCallback(
    (options?: { force?: boolean }) => {
      cancelPending();
      return save(options?.force ?? false);
    },
    [cancelPending, save],
  );

  /** Drops a scheduled save and waits out one in flight — before the draft is
   *  consumed by a create, so no late write lands on a created draft. */
  const settle = useCallback(async () => {
    cancelPending();
    if (inflightRef.current) await inflightRef.current.catch(() => null);
  }, [cancelPending]);

  return {
    draftId,
    record,
    hydrated,
    closed,
    loading: draftId !== null && !hydrated && query.isPending,
    loadFailed: draftId !== null && !hydrated && query.isError,
    saveState,
    flush,
    settle,
  };
}
