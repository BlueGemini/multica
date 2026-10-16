"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AgentConfigurationPanel } from "./agent-configuration-panel";
import {
  DiscardAgentDraftDialog,
  useHandDraftToAgent,
} from "./agent-draft-actions";
import { CreateAgentFooter } from "./create-agent-footer";
import { useAgentDraftSync } from "./use-agent-draft-sync";
import { useCreateAgentForm } from "./use-create-agent-form";
import { useCreateAgentSubmit } from "./use-create-agent-submit";
import { useDraftHelperAgent } from "./use-draft-helper-agent";
import { useDuplicateDraftSeed } from "./use-duplicate-draft-seed";

export interface AgentDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A saved draft to continue. Null starts a new one. */
  draftId: string | null;
  squadId?: string | null;
  /** Seeds a new draft from this agent. Ignored when `draftId` is set. */
  duplicateId?: string | null;
  /** False keeps the user where they are after creating — the draft card in a
   *  chat or a comment. */
  navigateOnCreate?: boolean;
  /** A new form just became a saved draft. */
  onDraftCreated?: (draftId: string) => void;
}

/**
 * The one editor every way of creating an agent goes through: a blank form, a
 * duplicate, a draft resumed from the agents list, and a draft an agent
 * proposed in a chat or a comment. It edits a server-side draft, so closing it
 * loses nothing, and only its owner can turn it into an agent.
 */
export function AgentDraftDialog({ open, onOpenChange, ...props }: AgentDraftDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="p-0 gap-0 flex flex-col overflow-hidden !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !w-full !max-w-3xl !h-[88vh]">
          <AgentDraftEditor {...props} onClose={() => onOpenChange(false)} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function AgentDraftEditor({
  draftId: initialDraftId,
  squadId = null,
  duplicateId = null,
  navigateOnCreate = true,
  onDraftCreated,
  onClose,
}: Omit<AgentDraftDialogProps, "open" | "onOpenChange"> & {
  onClose: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const helper = useDraftHelperAgent();
  const handToAgent = useHandDraftToAgent();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [handingOff, setHandingOff] = useState(false);

  // Fixed at open: once the copy is saved the URL names the draft instead, and
  // the create must still carry what only the source agent has.
  const [seedFromAgent] = useState(initialDraftId ? null : duplicateId);
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

  useDuplicateDraftSeed({
    source: duplicateAgent,
    runtimesSettled: form.runtimesSettled,
    runtimes: form.runtimes,
    currentUserId: form.currentUserId,
    fallbackRuntimeId: form.usableRuntimes[0]?.id ?? "",
    nameSuffix: t(($) => $.create_dialog.duplicate_copy_suffix),
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
    ready: !seedFromAgent || duplicateSeeded,
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
    onCreated: onClose,
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

  const create = async () => {
    await sync.settle();
    await submit.create();
  };

  const finishLater = async () => {
    try {
      await sync.flush({ force: true });
      onClose();
    } catch {
      // The save state already says it failed; keep the dialog open.
    }
  };

  const handOff = async () => {
    if (!helper) return;
    setHandingOff(true);
    try {
      const id = await sync.flush({ force: true });
      onClose();
      handToAgent(helper.id, id);
    } catch {
      setHandingOff(false);
    }
  };

  const title = duplicateAgent
    ? t(($) => $.creation_studio.duplicate_title, { name: duplicateAgent.name })
    : squadId
      ? t(($) => $.creation_studio.squad_title)
      : t(($) => $.creation_studio.title);

  return (
    <>
      <DialogHeader className="border-b px-5 py-3 space-y-0">
        <div className="flex items-baseline gap-3 pr-8">
          <DialogTitle className="text-title-sm font-semibold">{title}</DialogTitle>
          <SaveStatus state={sync.saveState} />
        </div>
        <DialogDescription className="text-caption text-muted-foreground">
          {t(($) => $.drafts.dialog_description)}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {sync.loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : sync.loadFailed ? (
          <Notice>{t(($) => $.drafts.load_failed)}</Notice>
        ) : (
          <>
            {sync.closed && record ? (
              <Notice>
                {record.status === "created"
                  ? t(($) => $.drafts.card_created)
                  : t(($) => $.drafts.card_discarded)}
              </Notice>
            ) : null}
            {duplicateAgent ? (
              <Notice>{t(($) => $.creation_studio.duplicate_env_notice)}</Notice>
            ) : null}
            {duplicateRuntimeReset ? (
              <Notice>
                {t(($) => $.creation_studio.duplicate_runtime_reset_notice)}
              </Notice>
            ) : null}
            <fieldset disabled={!editable} className="min-w-0">
              <AgentConfigurationPanel
                draft={form.draft}
                onChange={form.setDraft}
                runtimes={form.runtimes}
                runtimesLoading={form.runtimesLoading}
                members={form.members}
                currentUserId={form.currentUserId}
                nameError={submit.nameError}
                onNameChange={(name) => {
                  submit.clearNameError();
                  form.setDraft((current) => ({ ...current, name }));
                }}
              />
            </fieldset>
          </>
        )}
      </div>

      <CreateAgentFooter
        canCreate={canCreate}
        creating={submit.creating}
        squad={!!squadId}
        opensAgent={navigateOnCreate}
        error={submit.formError}
        onCreate={() => void create()}
        secondary={
          editable ? (
            <>
              {sync.draftId ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={submit.creating}
                  onClick={() => setConfirmDiscard(true)}
                >
                  {t(($) => $.drafts.discard)}
                </Button>
              ) : null}
              {helper ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submit.creating || handingOff}
                  onClick={() => void handOff()}
                >
                  {t(($) => $.drafts.hand_off, { name: helper.name })}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={submit.creating || handingOff}
                onClick={() => void finishLater()}
              >
                {t(($) => $.drafts.save_later)}
              </Button>
            </>
          ) : null
        }
      />

      {sync.draftId ? (
        <DiscardAgentDraftDialog
          draftId={sync.draftId}
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          onDiscarded={onClose}
        />
      ) : null}
    </>
  );
}

function SaveStatus({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  const { t } = useT("agents");
  if (state === "idle") return null;
  return (
    <span
      aria-live="polite"
      className={
        state === "error"
          ? "text-caption text-destructive"
          : "text-caption text-muted-foreground"
      }
    >
      {state === "saving"
        ? t(($) => $.drafts.saving)
        : state === "saved"
          ? t(($) => $.drafts.saved)
          : t(($) => $.drafts.save_failed)}
    </span>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body">
      {children}
    </div>
  );
}
