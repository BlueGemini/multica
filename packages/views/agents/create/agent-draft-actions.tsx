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
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

/**
 * Confirms, then discards. A draft an agent wrote is rejected instead, with an
 * optional reason kept on the draft for that agent to read. Awaits the server
 * before reporting success.
 */
export function DiscardAgentDraftDialog({
  draftId,
  open,
  onOpenChange,
  onDiscarded,
  authorName = null,
}: {
  draftId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscarded?: () => void;
  /** The agent that wrote the draft; turns discarding into rejecting. */
  authorName?: string | null;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState("");
  const rejecting = authorName !== null;

  const discard = async () => {
    setDiscarding(true);
    try {
      const record = await api.discardAgentDraft(draftId, rejecting ? reason.trim() : "");
      qc.setQueryData(agentDraftKeys.detail(wsId, draftId), record);
      await qc.invalidateQueries({ queryKey: agentDraftKeys.pending(wsId) });
      toast.success(rejecting ? t(($) => $.drafts.rejected) : t(($) => $.drafts.discarded));
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
          <AlertDialogTitle>
            {rejecting ? t(($) => $.drafts.reject_title) : t(($) => $.drafts.discard_title)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {rejecting
              ? t(($) => $.drafts.reject_confirm, { name: authorName })
              : t(($) => $.drafts.discard_confirm)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {rejecting ? (
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={3}
            aria-label={t(($) => $.drafts.reject_reason_label, { name: authorName })}
            placeholder={t(($) => $.drafts.reject_reason_placeholder, { name: authorName })}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={discarding}>
            {t(($) => $.drafts.discard_cancel)}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={discarding}
            onClick={() => void discard()}
          >
            {rejecting ? t(($) => $.drafts.reject) : t(($) => $.drafts.discard)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Opens a chat with the drafting agent. A saved draft pre-fills the composer
 * with a request that names it; otherwise the chat starts with the goal of
 * creating an agent. Nothing is sent: the member writes or reads it and sends.
 */
export function useHandDraftToAgent() {
  const { t } = useT("agents");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  return (agentId: string, draftId: string | null) => {
    navigation.push(
      draftId
        ? paths.chatWithAgent(agentId, {
            prompt: t(($) => $.drafts.handoff_prompt, { id: draftId }),
          })
        : paths.chatWithAgent(agentId, { goal: "create-agent" }),
    );
  };
}
