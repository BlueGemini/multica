"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import type { Agent } from "@multica/core/types";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useT } from "../../i18n";
import { AgentConfigurationPanel } from "./agent-configuration-panel";
import {
  DiscardAgentDraftDialog,
  useHandDraftToAgent,
} from "./agent-draft-actions";
import { latestRevisionChanges } from "./agent-draft-revision";
import { CreateAgentFooter } from "./create-agent-footer";
import type { AgentDraftSaveState } from "./use-agent-draft-sync";
import { useAgentDraftEditor } from "./use-agent-draft-editor";
import { useDraftHelperAgent } from "./use-draft-helper-agent";

export interface AgentDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A saved draft to continue. Null starts a new one. */
  draftId: string | null;
  squadId?: string | null;
  /** Seeds a new draft from this agent. Ignored when `draftId` is set. */
  duplicateId?: string | null;
  /** False keeps the user where they are after creating. */
  navigateOnCreate?: boolean;
  /** A new form just became a saved draft. */
  onDraftCreated?: (draftId: string) => void;
}

/**
 * The form for creating an agent by hand: a blank form, a duplicate, or a
 * draft resumed from the agents list. It edits the same server-side draft a
 * card in a chat or a comment shows, so closing it loses nothing, and only its
 * owner can turn it into an agent.
 */
export function AgentDraftDialog({ open, onOpenChange, ...props }: AgentDraftDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="p-0 gap-0 flex flex-col overflow-hidden !top-1/2 !left-1/2 !-translate-x-1/2 !-translate-y-1/2 !w-full !max-w-[600px] !max-h-[88vh]">
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
  const helper = useDraftHelperAgent();
  const handToAgent = useHandDraftToAgent();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  const editor = useAgentDraftEditor({
    draftId: initialDraftId,
    squadId,
    duplicateId,
    navigateOnCreate,
    onDraftCreated,
    onCreated: onClose,
  });
  const { form, sync, submit, record } = editor;
  const revisionChanges = latestRevisionChanges(record);

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

  const title = editor.duplicateAgent
    ? t(($) => $.creation_studio.duplicate_title, { name: editor.duplicateAgent.name })
    : squadId
      ? t(($) => $.creation_studio.squad_title)
      : t(($) => $.drafts.dialog_title);
  const copySources = editor.agents.filter((agent) => !agent.archived_at);

  return (
    <>
      <DialogHeader className="flex-row items-start gap-3 space-y-0 border-b px-5 py-3.5 pr-12">
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-title-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-0.5 text-caption text-muted-foreground">
            {t(($) => $.drafts.dialog_description)}
          </DialogDescription>
        </div>
        <SaveStatus state={sync.saveState} />
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
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
            {editor.duplicateAgent ? (
              <Notice>{t(($) => $.creation_studio.duplicate_env_notice)}</Notice>
            ) : null}
            {editor.duplicateRuntimeReset ? (
              <Notice>{t(($) => $.creation_studio.duplicate_runtime_reset_notice)}</Notice>
            ) : null}
            <fieldset disabled={!editor.editable} className="min-w-0">
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
                changedFields={revisionChanges.changedFields}
                previousInstructions={revisionChanges.previousInstructions}
                runtimeHint={
                  initialDraftId === null && !editor.duplicateAgent
                    ? t(($) => $.drafts.form.runtime_auto_hint)
                    : null
                }
                instructionsFooter={
                  editor.editable ? (
                    <InstructionsFooter
                      copySources={copySources}
                      onCopy={editor.copyFromAgent}
                      helper={helper}
                      handingOff={handingOff}
                      onHandOff={() => void handOff()}
                    />
                  ) : null
                }
              />
            </fieldset>
          </>
        )}
      </div>

      <CreateAgentFooter
        canCreate={editor.canCreate}
        creating={submit.creating}
        squad={!!squadId}
        error={submit.formError}
        note={t(($) => $.drafts.after_create_note)}
        onCreate={() => void editor.create()}
        secondary={
          editor.editable ? (
            <>
              {initialDraftId && sync.draftId ? (
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
              <Button
                type="button"
                variant="ghost"
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

function InstructionsFooter({
  copySources,
  onCopy,
  helper,
  handingOff,
  onHandOff,
}: {
  copySources: Agent[];
  onCopy: (agentId: string) => void;
  helper: Agent | null;
  handingOff: boolean;
  onHandOff: () => void;
}) {
  const { t } = useT("agents");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {copySources.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" size="xs" variant="outline" className="gap-1">
                <Copy aria-hidden="true" className="size-3" />
                {t(($) => $.drafts.form.copy_from_agent)}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 w-auto min-w-48 overflow-y-auto">
            {copySources.map((agent) => (
              <DropdownMenuItem key={agent.id} onClick={() => onCopy(agent.id)}>
                <ActorAvatar
                  name={agent.name}
                  initials={agent.name.slice(0, 1).toUpperCase()}
                  avatarUrl={agent.avatar_url}
                  isAgent
                  size="sm"
                />
                <span className="min-w-0 truncate">{agent.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span />
      )}
      {helper ? (
        <div className="flex items-center gap-1.5 text-caption">
          <span className="text-muted-foreground">{t(($) => $.drafts.form.rather_not_write)}</span>
          <button
            type="button"
            disabled={handingOff}
            onClick={onHandOff}
            className="inline-flex items-center gap-1 font-medium text-info hover:underline disabled:opacity-50"
          >
            <ActorAvatar
              name={helper.name}
              initials={helper.name.slice(0, 1).toUpperCase()}
              avatarUrl={helper.avatar_url}
              isAgent
              size="xs"
            />
            {t(($) => $.drafts.hand_off, { name: helper.name })}
            <ChevronRight aria-hidden="true" className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SaveStatus({ state }: { state: AgentDraftSaveState }) {
  const { t } = useT("agents");
  if (state === "idle") return null;
  return (
    <span
      aria-live="polite"
      className={
        state === "error"
          ? "mt-0.5 shrink-0 text-caption text-destructive"
          : "mt-0.5 inline-flex shrink-0 items-center gap-1 text-caption text-muted-foreground"
      }
    >
      {state === "saved" ? <Check aria-hidden="true" className="size-3.5" /> : null}
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
    <div className="mx-5 mt-4 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-body">
      {children}
    </div>
  );
}
