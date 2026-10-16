"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildDuplicateDraft } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { useT } from "../../i18n";
import { useAgentDraftSync } from "./use-agent-draft-sync";
import { useCreateAgentForm } from "./use-create-agent-form";
import { useCreateAgentSubmit } from "./use-create-agent-submit";
import { useDuplicateDraftSeed } from "./use-duplicate-draft-seed";

/**
 * Everything an editor of an agent draft needs — the form, its server sync and
 * the create — shared by the dialog and the card's in-place editor so both
 * behave the same.
 */
export function useAgentDraftEditor({
  draftId: initialDraftId,
  squadId = null,
  duplicateId = null,
  navigateOnCreate = true,
  onDraftCreated,
  onCreated,
}: {
  draftId: string | null;
  squadId?: string | null;
  duplicateId?: string | null;
  navigateOnCreate?: boolean;
  onDraftCreated?: (draftId: string) => void;
  onCreated?: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();

  // Fixed at open (or by "copy from an agent"): once the copy is saved the URL
  // names the draft instead, and the create must still carry what only the
  // source agent has.
  const [seedFromAgent, setSeedFromAgent] = useState(initialDraftId ? null : duplicateId);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const duplicateAgent = seedFromAgent
    ? agents.find((agent) => agent.id === seedFromAgent) ?? null
    : null;
  const [duplicateRuntimeReset, setDuplicateRuntimeReset] = useState(false);
  const [duplicateSeeded, setDuplicateSeeded] = useState(false);

  // A saved draft owns its runtime; seeding one before it hydrates would
  // record the list-order fallback as the user's choice.
  const [runtimeSeedReady, setRuntimeSeedReady] = useState(initialDraftId === null);
  const form = useCreateAgentForm({
    runtimeSeed: { ready: runtimeSeedReady, runtimeId: "" },
  });
  const nameSuffix = t(($) => $.create_dialog.duplicate_copy_suffix);

  useDuplicateDraftSeed({
    source: initialDraftId ? null : duplicateAgent,
    runtimesSettled: form.runtimesSettled,
    runtimes: form.runtimes,
    currentUserId: form.currentUserId,
    fallbackRuntimeId: form.usableRuntimes[0]?.id ?? "",
    nameSuffix,
    onSeed: (duplicated, runtimeReset) => {
      setDuplicateRuntimeReset(runtimeReset);
      form.setDraft(duplicated);
      setDuplicateSeeded(true);
    },
  });

  const sync = useAgentDraftSync({
    draftId: initialDraftId,
    draft: form.draft,
    setDraft: form.setDraft,
    ready: !seedFromAgent || duplicateSeeded || initialDraftId !== null,
    onDraftCreated,
  });
  useEffect(() => {
    if (sync.hydrated) setRuntimeSeedReady(true);
  }, [sync.hydrated]);

  const submit = useCreateAgentSubmit({
    draft: form.draft,
    runtimeId: form.selectedRuntime?.id ?? null,
    squadId,
    duplicateSource: duplicateAgent,
    draftId: sync.draftId,
    navigateOnCreate,
    onCreated,
  });

  const record = sync.record;
  const ownedByOther =
    record !== null && !!form.currentUserId && record.owner_id !== form.currentUserId;
  const editable = !sync.closed && !ownedByOther && !sync.loading && !sync.loadFailed;
  const canCreate =
    editable &&
    form.draft.name.trim().length > 0 &&
    form.draftReady &&
    !submit.creating;

  /** Replaces the form with a copy of an existing agent, keeping the draft. */
  const copyFromAgent = (agentId: string) => {
    const source = agents.find((agent) => agent.id === agentId);
    if (!source) return;
    const duplicated = buildDuplicateDraft(source, {
      runtimes: form.runtimes,
      currentUserId: form.currentUserId,
      fallbackRuntimeId: form.usableRuntimes[0]?.id ?? "",
      nameSuffix,
    });
    setSeedFromAgent(agentId);
    setDuplicateRuntimeReset(duplicated.runtimeId !== source.runtime_id);
    setDuplicateSeeded(true);
    form.setDraft(duplicated);
  };

  const create = async () => {
    await sync.settle();
    await submit.create();
  };

  return {
    form,
    sync,
    submit,
    record,
    agents,
    duplicateAgent,
    duplicateRuntimeReset,
    editable,
    canCreate,
    create,
    copyFromAgent,
  };
}
