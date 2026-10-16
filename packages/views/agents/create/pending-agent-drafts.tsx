"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pendingAgentDraftsOptions } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import type { AgentDraftRecord } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import { useT, useTimeAgo } from "../../i18n";
import { AppLink } from "../../navigation";
import { DiscardAgentDraftDialog } from "./agent-draft-actions";

/**
 * Drafts only this member can turn into agents — their own unfinished forms
 * and what agents proposed for them in chats and issues. Hidden when empty.
 */
export function PendingAgentDrafts({
  onContinue,
}: {
  onContinue: (draftId: string) => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: drafts = [] } = useQuery(pendingAgentDraftsOptions(wsId));
  const [discarding, setDiscarding] = useState<string | null>(null);

  if (drafts.length === 0) return null;

  return (
    <section
      aria-label={t(($) => $.drafts.pending_title)}
      className="border-b px-5 py-4"
    >
      <div className="mb-3">
        <h2 className="text-body font-medium">{t(($) => $.drafts.pending_title)}</h2>
        <p className="text-caption text-muted-foreground">
          {t(($) => $.drafts.pending_hint)}
        </p>
      </div>
      <ul className="grid gap-2 @3xl:grid-cols-2">
        {drafts.map((draft) => (
          <PendingDraftRow
            key={draft.id}
            draft={draft}
            onContinue={() => onContinue(draft.id)}
            onDiscard={() => setDiscarding(draft.id)}
          />
        ))}
      </ul>
      {discarding ? (
        <DiscardAgentDraftDialog
          draftId={discarding}
          open
          onOpenChange={(open) => {
            if (!open) setDiscarding(null);
          }}
        />
      ) : null}
    </section>
  );
}

function PendingDraftRow({
  draft,
  onContinue,
  onDiscard,
}: {
  draft: AgentDraftRecord;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const name = draft.config.name.trim() || t(($) => $.drafts.untitled);
  const author =
    draft.author_type === "agent"
      ? agents.find((agent) => agent.id === draft.author_id)?.name ?? ""
      : "";
  const source = draft.source_chat_session_id
    ? {
        href: paths.chatSession(draft.source_chat_session_id),
        label: t(($) => $.drafts.open_chat),
      }
    : draft.source_issue_id
      ? {
          href: paths.issueDetail(draft.source_issue_id),
          label: t(($) => $.drafts.open_issue),
        }
      : null;

  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <ActorAvatar
        name={name}
        initials={name.slice(0, 1).toUpperCase()}
        avatarUrl={draft.config.avatar_url}
        isAgent
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium">{name}</div>
        <div className="truncate text-caption text-muted-foreground">
          {draft.author_type === "agent"
            ? t(($) => $.drafts.authored_by_agent, { name: author || "—" })
            : t(($) => $.drafts.authored_by_you)}
          {draft.updated_at ? ` · ${timeAgo(draft.updated_at)}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {source ? (
          <Button
            size="sm"
            variant="ghost"
            className="hidden text-muted-foreground @xl:inline-flex"
            render={<AppLink href={source.href} />}
          >
            {source.label}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={onDiscard}
        >
          {t(($) => $.drafts.discard)}
        </Button>
        <Button size="sm" variant="outline" onClick={onContinue}>
          {t(($) => $.drafts.continue)}
        </Button>
      </div>
    </li>
  );
}
