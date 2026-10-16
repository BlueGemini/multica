"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentDraftOptions } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { runtimeDisplayLabel, runtimeListOptions } from "@multica/core/runtimes";
import type { AgentDraftRecord } from "@multica/core/types";
import { memberListOptions } from "@multica/core/workspace/queries";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { DiscardAgentDraftDialog } from "./agent-draft-actions";
import { AgentDraftDialog } from "./agent-draft-dialog";

/**
 * An agent draft where it was proposed — a chat reply or an issue comment.
 * The owner reviews it in the same editor the agents page uses and creates it
 * without leaving the conversation; everyone else sees what is being proposed
 * and whose confirmation it waits on.
 */
export function AgentDraftCard({ draftId }: { draftId: string }) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: record, isError } = useQuery(agentDraftOptions(wsId, draftId));

  if (isError) {
    return <CardShell muted>{t(($) => $.drafts.card_unavailable)}</CardShell>;
  }
  if (!record) {
    return (
      <CardShell>
        <div className="h-12 animate-pulse rounded-md bg-muted/60" />
      </CardShell>
    );
  }
  return <AgentDraftCardBody record={record} />;
}

function AgentDraftCardBody({ record }: { record: AgentDraftRecord }) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const { config } = record;
  const name = config.name.trim() || t(($) => $.drafts.untitled);
  const runtime = runtimes.find((item) => item.id === config.runtime_id);
  const isOwner = !!currentUserId && record.owner_id === currentUserId;
  const ownerName =
    members.find((member) => member.user_id === record.owner_id)?.name ?? "";

  return (
    <CardShell>
      <div className="flex items-start gap-3">
        <ActorAvatar
          name={name}
          initials={name.slice(0, 1).toUpperCase()}
          avatarUrl={config.avatar_url}
          isAgent
          size="xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            <span>{t(($) => $.drafts.card_label)}</span>
            {record.status !== "pending" ? (
              <span className="rounded-sm bg-muted px-1.5 py-px text-micro font-medium">
                {record.status === "created"
                  ? t(($) => $.drafts.card_created)
                  : t(($) => $.drafts.card_discarded)}
              </span>
            ) : null}
          </div>
          <div className="truncate text-body font-medium">{name}</div>
          {config.description ? (
            <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">
              {config.description}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>
              {runtime
                ? runtimeDisplayLabel(runtime)
                : t(($) => $.drafts.card_no_runtime)}
            </Chip>
            {config.model ? <Chip>{config.model}</Chip> : null}
            {config.skill_ids.length > 0 ? (
              <Chip>
                {t(($) => $.drafts.card_skills, {
                  count: config.skill_ids.length,
                })}
              </Chip>
            ) : null}
            <Chip>
              {t(($) => $.creation_studio.access[config.permission_scope].title)}
            </Chip>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {record.status === "pending" && isOwner ? (
          <>
            <Button type="button" size="sm" onClick={() => setEditing(true)}>
              {t(($) => $.drafts.card_review)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setConfirmDiscard(true)}
            >
              {t(($) => $.drafts.discard)}
            </Button>
          </>
        ) : record.status === "pending" ? (
          <span className="text-caption text-muted-foreground">
            {t(($) => $.drafts.card_waiting, { name: ownerName || "—" })}
          </span>
        ) : record.status === "created" && record.created_agent_id ? (
          <AppLink
            href={paths.agentDetail(record.created_agent_id)}
            className="text-caption font-medium text-primary hover:underline"
          >
            {t(($) => $.drafts.open_agent)}
          </AppLink>
        ) : null}
      </div>

      {isOwner ? (
        <>
          <AgentDraftDialog
            open={editing}
            onOpenChange={setEditing}
            draftId={record.id}
            navigateOnCreate={false}
          />
          <DiscardAgentDraftDialog
            draftId={record.id}
            open={confirmDiscard}
            onOpenChange={setConfirmDiscard}
          />
        </>
      ) : null}
    </CardShell>
  );
}

function CardShell({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      data-agent-draft-card=""
      className={cn(
        "not-prose my-2 max-w-xl rounded-lg border bg-card p-3",
        muted && "text-caption text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-full truncate rounded-md border bg-muted/40 px-1.5 py-0.5 text-micro text-muted-foreground">
      {children}
    </span>
  );
}
