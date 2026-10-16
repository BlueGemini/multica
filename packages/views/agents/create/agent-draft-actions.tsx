"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agentDraftKeys } from "@multica/core/agents";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
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
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

/** Confirms, then discards. Awaits the server before reporting success. */
export function DiscardAgentDraftDialog({
  draftId,
  open,
  onOpenChange,
  onDiscarded,
}: {
  draftId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscarded?: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [discarding, setDiscarding] = useState(false);

  const discard = async () => {
    setDiscarding(true);
    try {
      const record = await api.discardAgentDraft(draftId);
      qc.setQueryData(agentDraftKeys.detail(wsId, draftId), record);
      await qc.invalidateQueries({ queryKey: agentDraftKeys.pending(wsId) });
      toast.success(t(($) => $.drafts.discarded));
      onOpenChange(false);
      onDiscarded?.();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.drafts.discard_failed),
      );
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!discarding) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.drafts.discard_title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.drafts.discard_confirm)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={discarding}>
            {t(($) => $.drafts.discard_cancel)}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={discarding}
            onClick={() => void discard()}
          >
            {t(($) => $.drafts.discard)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Opens a chat with the drafting agent, the composer pre-filled with a request
 * that names this draft. Nothing is sent: the member reads it and sends it.
 */
export function useHandDraftToAgent() {
  const { t } = useT("agents");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  return (agentId: string, draftId: string | null) => {
    const prompt = draftId
      ? t(($) => $.drafts.handoff_prompt, { id: draftId })
      : t(($) => $.drafts.agent_prompt);
    navigation.push(paths.chatWithAgent(agentId, { prompt }));
  };
}
