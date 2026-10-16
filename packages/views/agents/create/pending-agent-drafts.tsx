"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Globe, Loader2, Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { pendingAgentDraftsOptions } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import type { AgentDraftRecord } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import { useT, useTimeAgo } from "../../i18n";
import { AppLink } from "../../navigation";
import { DiscardAgentDraftDialog } from "./agent-draft-actions";
import { useDirectCreateDraft } from "./use-direct-create-draft";

/**
 * Drafts only this member can turn into agents — their own unfinished forms
 * and what agents proposed for them in chats and issues — confirmable here
 * wherever they were written. Hidden when empty, and so is `listHeading`,
 * which titles the agent list below once there is something to tell it from.
 */
export function PendingAgentDrafts({
  onContinue,
  listHeading,
}: {
  onContinue: (draftId: string) => void;
  listHeading?: string;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: drafts = [] } = useQuery(pendingAgentDraftsOptions(wsId));
  const [discarding, setDiscarding] = useState<AgentDraftRecord | null>(null);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const authorName = (draft: AgentDraftRecord) =>
    draft.author_type === "agent"
      ? agents.find((agent) => agent.id === draft.author_id)?.name ?? ""
      : null;

  if (drafts.length === 0) return null;

  return (
    <>
      <section aria-label={t(($) => $.drafts.pending_title)} className="px-5 pt-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-body font-medium">{t(($) => $.drafts.pending_title)}</h2>
          <span className="rounded-full bg-warning/15 px-1.5 text-micro font-medium tabular-nums text-warning">
            {drafts.length}
          </span>
          <p className="hidden truncate text-caption text-muted-foreground @xl:block">
            {t(($) => $.drafts.pending_hint)}
          </p>
        </div>
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {drafts.map((draft) => (
            <PendingDraftRow
              key={draft.id}
              draft={draft}
              author={authorName(draft)}
              onContinue={() => onContinue(draft.id)}
              onDiscard={() => setDiscarding(draft)}
            />
          ))}
        </ul>
        {discarding ? (
          <DiscardAgentDraftDialog
            draftId={discarding.id}
            open
            onOpenChange={(open) => {
              if (!open) setDiscarding(null);
            }}
            authorName={authorName(discarding)}
          />
        ) : null}
      </section>
      {listHeading ? (
        <h2 className="px-5 pb-1 pt-5 text-body font-medium">{listHeading}</h2>
      ) : null}
    </>
  );
}

function PendingDraftRow({
  draft,
  author,
  onContinue,
  onDiscard,
}: {
  draft: AgentDraftRecord;
  /** The authoring agent's name; null when the member started it. */
  author: string | null;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const direct = useDirectCreateDraft(draft);
  useEffect(() => {
    if (direct.error) toast.error(direct.error);
  }, [direct.error]);
  const { data: sourceIssue } = useQuery({
    ...issueDetailOptions(wsId, draft.source_issue_id ?? ""),
    enabled: !!draft.source_issue_id,
  });
  const { config } = draft;
  const name = config.name.trim() || t(($) => $.drafts.untitled);

  const source = draft.source_chat_session_id
    ? {
        href: paths.chatSession(draft.source_chat_session_id),
        action: t(($) => $.drafts.open_chat),
        label: t(($) => $.drafts.source_chat),
      }
    : draft.source_issue_id
      ? {
          href: paths.issueDetail(draft.source_issue_id),
          action: t(($) => $.drafts.open_issue),
          label: sourceIssue?.identifier
            ? t(($) => $.drafts.source_issue, { identifier: sourceIssue.identifier })
            : t(($) => $.drafts.source_issue_unknown),
        }
      : null;
  const origin = [
    author !== null
      ? t(($) => $.drafts.authored_by_agent, { name: author || "—" })
      : t(($) => $.drafts.authored_by_you),
    source?.label ?? t(($) => $.drafts.source_form),
  ].join(" · ");

  const AccessIcon =
    config.permission_scope === "workspace"
      ? Globe
      : config.permission_scope === "members"
        ? Users
        : Lock;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-3 py-2.5 @3xl:grid-cols-[minmax(0,1fr)_13rem_8rem_auto]">
      <button
        type="button"
        onClick={onContinue}
        className="flex min-w-0 items-center gap-3 text-left"
      >
        <ActorAvatar
          name={name}
          initials={name.slice(0, 1).toUpperCase()}
          avatarUrl={config.avatar_url}
          isAgent
          size="lg"
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body font-medium">{name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-info/10 px-1.5 py-px text-micro font-medium text-info">
              <FileText aria-hidden="true" className="size-3" />
              {t(($) => $.drafts.draft_badge)}
            </span>
          </span>
          {config.description ? (
            <span className="block truncate text-caption text-muted-foreground">
              {config.description}
            </span>
          ) : null}
        </span>
      </button>
      <div className="hidden min-w-0 text-caption @3xl:block">
        <div className="truncate">{origin}</div>
        {draft.updated_at ? (
          <div className="truncate text-muted-foreground">{timeAgo(draft.updated_at)}</div>
        ) : null}
      </div>
      <div className="hidden @3xl:flex">
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-micro text-muted-foreground">
          <AccessIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            {config.permission_scope === "members"
              ? t(($) => $.drafts.card_members, {
                  count: config.member_ids.length + config.team_ids.length,
                })
              : t(($) => $.creation_studio.access[config.permission_scope].title)}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={onDiscard}
        >
          {author !== null ? t(($) => $.drafts.reject) : t(($) => $.drafts.discard)}
        </Button>
        {source ? (
          <Button
            size="sm"
            variant="outline"
            className="hidden @xl:inline-flex"
            nativeButton={false}
            render={<AppLink href={source.href} />}
          >
            {source.action}
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={direct.creating}
          onClick={() => {
            if (direct.ready) void direct.create();
            else onContinue();
          }}
        >
          {direct.creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t(($) => $.drafts.create)}
        </Button>
      </div>
    </li>
  );
}
