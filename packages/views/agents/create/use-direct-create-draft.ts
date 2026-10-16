"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fromAgentDraftConfig } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeListOptions } from "@multica/core/runtimes";
import type { AgentDraftRecord } from "@multica/core/types";
import { isDraftReady } from "./use-create-agent-form";
import { useCreateAgentSubmit } from "./use-create-agent-submit";

/**
 * Creates a saved draft as it stands, without opening an editor. `ready` is
 * false whenever the editor would refuse too, so callers open it instead.
 */
export function useDirectCreateDraft(record: AgentDraftRecord) {
  const wsId = useWorkspaceId();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const draft = useMemo(() => fromAgentDraftConfig(record.config), [record.config]);
  const runtime = runtimes.find((item) => item.id === draft.runtimeId) ?? null;
  const submit = useCreateAgentSubmit({
    draft,
    runtimeId: runtime?.id ?? null,
    squadId: null,
    draftId: record.id,
    navigateOnCreate: false,
  });
  return {
    ready:
      record.status === "pending" &&
      draft.name.trim().length > 0 &&
      isDraftReady(draft, runtime, currentUserId),
    creating: submit.creating,
    error: submit.nameError ?? submit.formError,
    create: submit.create,
  };
}
