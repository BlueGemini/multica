"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Check,
  FileText,
  Globe,
  History,
  Loader2,
  Lock,
  Users,
} from "lucide-react";
import { agentDraftOptions } from "@multica/core/agents";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useModalStore } from "@multica/core/modals";
import { useWorkspacePaths } from "@multica/core/paths";
import { runtimeDisplayLabel, runtimeListOptions } from "@multica/core/runtimes";
import type { AgentDraftConfig, AgentDraftRecord } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
  skillListOptions,
} from "@multica/core/workspace/queries";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT, useTimeAgo } from "../../i18n";
import { AppLink } from "../../navigation";
import { AgentConfigurationPanel } from "./agent-configuration-panel";
import { DiscardAgentDraftDialog } from "./agent-draft-actions";
import { latestRevisionChanges } from "./agent-draft-revision";
import { useAgentDraftEditor } from "./use-agent-draft-editor";
import { useDirectCreateDraft } from "./use-direct-create-draft";

/**
 * An agent draft where it was proposed — a chat reply or an issue comment.
 * The owner reviews it in place, edits it inside the card or creates it as it
 * stands; everyone else sees what is being proposed and whose confirmation it
 * waits on. A link to an older revision collapses to one line so the
 * conversation reads as a history of the same draft.
 */
export function AgentDraftCard({
  draftId,
  revision = null,
}: {
  draftId: string;
  /** The revision the link was posted for, when it names one. */
  revision?: number | null;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: record, isError } = useQuery(agentDraftOptions(wsId, draftId));

  if (isError) {
    return (
      <CardShell>
        <p className="px-4 py-3 text-caption text-muted-foreground">
          {t(($) => $.drafts.card_unavailable)}
        </p>
      </CardShell>
    );
  }
  if (!record) {
    return (
      <CardShell>
        <div className="m-3 h-16 animate-pulse rounded-md bg-muted/60" />
      </CardShell>
    );
  }
  if (revision !== null && revision < record.revision) {
    return <SupersededCard record={record} revision={revision} />;
  }
  if (record.status === "created") return <CreatedCard record={record} />;
  if (record.status === "discarded") return <DiscardedCard record={record} />;
  return <PendingCard record={record} />;
}

function useDraftPeople(record: AgentDraftRecord) {
  const wsId = useWorkspaceId();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  return {
    isOwner: !!currentUserId && record.owner_id === currentUserId,
    ownerName: members.find((member) => member.user_id === record.owner_id)?.name ?? "",
    authorAgentName:
      record.author_type === "agent"
        ? agents.find((agent) => agent.id === record.author_id)?.name ?? null
        : null,
  };
}

function PendingCard({ record }: { record: AgentDraftRecord }) {
  const { t } = useT("agents");
  const { isOwner, ownerName, authorAgentName } = useDraftPeople(record);
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const direct = useDirectCreateDraft(record);
  const rejectingAgent = record.author_type === "agent" ? authorAgentName ?? "" : null;

  const create = () => {
    if (direct.ready) void direct.create();
    else setExpanded(true);
  };

  const meta = [
    authorAgentName && record.source_issue_id
      ? t(($) => $.drafts.authored_by_agent, { name: authorAgentName })
      : null,
    isOwner ? t(($) => $.drafts.create_as_you) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CardShell liveDraftId={record.id}>
      <CardHeader
        record={record}
        pendingLabel={
          isOwner ? t(($) => $.drafts.badge_pending_you) : t(($) => $.drafts.badge_pending)
        }
        right={
          expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-0.5 text-caption text-muted-foreground hover:text-foreground"
            >
              {t(($) => $.drafts.collapse)}
              <ChevronUp aria-hidden="true" className="size-3.5" />
            </button>
          ) : (
            <span className="truncate text-caption text-muted-foreground">{meta}</span>
          )
        }
      />

      {expanded && isOwner ? (
        <InlineEditor
          record={record}
          rejectingAgent={rejectingAgent}
          onReject={() => setConfirmDiscard(true)}
        />
      ) : (
        <>
          <DraftSummary
            config={record.config}
            onExpand={isOwner ? () => setExpanded(true) : undefined}
          />
          <FollowUps record={record} />
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            {isOwner ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setConfirmDiscard(true)}
                >
                  {rejectingAgent !== null ? t(($) => $.drafts.reject) : t(($) => $.drafts.discard)}
                </Button>
                {direct.error ? (
                  <span role="alert" className="min-w-0 flex-1 truncate text-caption text-destructive">
                    {direct.error}
                  </span>
                ) : (
                  <span className="hidden min-w-0 flex-1 truncate text-caption text-muted-foreground sm:block">
                    {authorAgentName && record.source_issue_id
                      ? t(($) => $.drafts.reject_hint, { name: authorAgentName })
                      : null}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setExpanded(true)}
                  >
                    {t(($) => $.drafts.expand_review)}
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  </Button>
                  <Button type="button" size="sm" disabled={direct.creating} onClick={create}>
                    {direct.creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t(($) => $.drafts.create_agent)}
                  </Button>
                </div>
              </>
            ) : (
              <span className="px-1 py-1 text-caption text-muted-foreground">
                {t(($) => $.drafts.card_waiting, { name: ownerName || "—" })}
              </span>
            )}
          </div>
        </>
      )}

      {isOwner ? (
        <DiscardAgentDraftDialog
          draftId={record.id}
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          authorName={rejectingAgent}
        />
      ) : null}
    </CardShell>
  );
}

function InlineEditor({
  record,
  rejectingAgent,
  onReject,
}: {
  record: AgentDraftRecord;
  rejectingAgent: string | null;
  onReject: () => void;
}) {
  const { t } = useT("agents");
  const editor = useAgentDraftEditor({ draftId: record.id, navigateOnCreate: false });
  const { form, sync, submit } = editor;
  const changes = latestRevisionChanges(record);

  if (sync.loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const error = submit.formError ?? (sync.saveState === "error" ? t(($) => $.drafts.save_failed) : null);
  return (
    <>
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
          changedFields={changes.changedFields}
          previousInstructions={changes.previousInstructions}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={onReject}
        >
          {rejectingAgent !== null ? t(($) => $.drafts.reject) : t(($) => $.drafts.discard)}
        </Button>
        {error ? (
          <span role="alert" className="min-w-0 flex-1 truncate text-caption text-destructive">
            {error}
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1 text-caption text-muted-foreground">
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{t(($) => $.drafts.inline_note)}</span>
          </span>
        )}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!editor.canCreate}
          onClick={() => void editor.create()}
        >
          {submit.creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t(($) => $.drafts.create_agent)}
        </Button>
      </div>
    </>
  );
}

function SupersededCard({ record, revision }: { record: AgentDraftRecord; revision: number }) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const snapshot = record.revisions.find((entry) => entry.revision === revision)?.config;
  const name = (snapshot ?? record.config).name.trim() || t(($) => $.drafts.untitled);
  return (
    <CardShell>
      <div className="flex items-center gap-2 px-3 py-2 text-caption text-muted-foreground">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {name} · {t(($) => $.drafts.card_revision, { count: revision })} ·{" "}
          {t(($) => $.drafts.superseded, { count: record.revision })}
        </span>
        {snapshot ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground"
          >
            <History aria-hidden="true" className="size-3.5" />
            {open ? t(($) => $.drafts.collapse) : t(($) => $.drafts.view_revision)}
          </button>
        ) : null}
      </div>
      {open && snapshot ? (
        <div className="border-t">
          <DraftSummary config={snapshot} />
        </div>
      ) : null}
    </CardShell>
  );
}

function CreatedCard({ record }: { record: AgentDraftRecord }) {
  const { t } = useT("agents");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const { isOwner, ownerName } = useDraftPeople(record);
  const name = record.config.name.trim() || t(($) => $.drafts.untitled);
  const agentId = record.created_agent_id;
  return (
    <CardShell>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <ActorAvatar
          name={name}
          initials={name.slice(0, 1).toUpperCase()}
          avatarUrl={record.config.avatar_url}
          isAgent
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-medium">{name}</span>
            <Badge tone="success">
              <Check aria-hidden="true" className="size-3" />
              {t(($) => $.drafts.card_created)}
            </Badge>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
            <RuntimeLabel runtimeId={record.config.runtime_id} />
            <span>·</span>
            <span className="truncate">
              {t(($) => $.creation_studio.access[record.config.permission_scope].title)}
            </span>
            <span>·</span>
            <span className="truncate">
              {isOwner
                ? t(($) => $.drafts.created_by_you, { time: timeAgo(record.updated_at) })
                : t(($) => $.drafts.created_by, {
                    name: ownerName || "—",
                    time: timeAgo(record.updated_at),
                  })}
            </span>
          </div>
        </div>
        {agentId ? (
          <div className="flex shrink-0 items-center gap-2">
            {isOwner ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  useModalStore.getState().open("quick-create-issue", { agent_id: agentId })
                }
              >
                {t(($) => $.drafts.assign_first_task)}
              </Button>
            ) : null}
            <AppLink
              href={paths.agentDetail(agentId)}
              className={buttonVariants({ size: "sm" })}
            >
              {t(($) => $.drafts.open_agent)}
            </AppLink>
          </div>
        ) : null}
      </div>
    </CardShell>
  );
}

function DiscardedCard({ record }: { record: AgentDraftRecord }) {
  const { t } = useT("agents");
  const name = record.config.name.trim() || t(($) => $.drafts.untitled);
  const rejected = record.author_type === "agent";
  return (
    <CardShell>
      <div className="px-3 py-2 text-caption text-muted-foreground">
        <div className="flex items-center gap-2">
          <FileText aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{name}</span>
          <Badge tone="muted">
            {rejected ? t(($) => $.drafts.card_rejected) : t(($) => $.drafts.card_discarded)}
          </Badge>
        </div>
        {record.discard_reason ? (
          <p className="mt-1 whitespace-pre-wrap break-words pl-5.5">
            {t(($) => $.drafts.reject_reason_shown, { reason: record.discard_reason })}
          </p>
        ) : null}
      </div>
    </CardShell>
  );
}

function CardHeader({
  record,
  pendingLabel,
  right,
}: {
  record: AgentDraftRecord;
  pendingLabel: string;
  right?: ReactNode;
}) {
  const { t } = useT("agents");
  return (
    <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <Badge tone="info">
        <FileText aria-hidden="true" className="size-3" />
        {t(($) => $.drafts.card_label)}
      </Badge>
      <Badge tone="warning">{pendingLabel}</Badge>
      {record.revision > 0 ? (
        <span className="text-caption text-muted-foreground">
          {t(($) => $.drafts.card_revision, { count: record.revision })}
        </span>
      ) : null}
      <div className="ml-auto flex min-w-0 justify-end">{right}</div>
    </div>
  );
}

/** What the draft would create, at a glance. */
function DraftSummary({
  config,
  onExpand,
}: {
  config: AgentDraftConfig;
  onExpand?: () => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: skills = [] } = useQuery(skillListOptions(wsId));
  const name = config.name.trim() || t(($) => $.drafts.untitled);
  const skillNames = config.skill_ids
    .map((id) => skills.find((skill) => skill.id === id)?.name)
    .filter((value): value is string => !!value);
  const AccessIcon =
    config.permission_scope === "workspace"
      ? Globe
      : config.permission_scope === "members"
        ? Users
        : Lock;
  const grantees = config.member_ids.length + config.team_ids.length;

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <ActorAvatar
          name={name}
          initials={name.slice(0, 1).toUpperCase()}
          avatarUrl={config.avatar_url}
          isAgent
          size="xl"
        />
        <div className="min-w-0">
          <div className="truncate text-body font-semibold">{name}</div>
          {config.description ? (
            <p className="line-clamp-2 text-caption text-muted-foreground">
              {config.description}
            </p>
          ) : null}
        </div>
      </div>
      <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[1.4fr_1.4fr_1fr_1fr]">
        <SummaryItem label={t(($) => $.create_dialog.runtime_label)}>
          <RuntimeLabel runtimeId={config.runtime_id} />
        </SummaryItem>
        <SummaryItem label={t(($) => $.create_dialog.skills_section.label)}>
          <span className="truncate">{skillNames.length > 0 ? skillNames.join(", ") : "—"}</span>
        </SummaryItem>
        <SummaryItem label={t(($) => $.creation_studio.sections.access)}>
          <AccessIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {config.permission_scope === "members"
              ? t(($) => $.drafts.card_members, { count: grantees })
              : t(($) => $.creation_studio.access[config.permission_scope].title)}
          </span>
        </SummaryItem>
        <SummaryItem label={t(($) => $.create_dialog.instructions.label)}>
          <span className="truncate">
            {config.instructions.trim()
              ? t(($) => $.drafts.card_instructions, {
                  count: [...config.instructions].length,
                })
              : "—"}
          </span>
          {onExpand && config.instructions.trim() ? (
            <button
              type="button"
              onClick={onExpand}
              className="shrink-0 text-info hover:underline"
            >
              · {t(($) => $.drafts.expand)}
            </button>
          ) : null}
        </SummaryItem>
      </dl>
    </div>
  );
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-caption text-foreground">
        {children}
      </dd>
    </div>
  );
}

function RuntimeLabel({ runtimeId }: { runtimeId: string }) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const runtime = runtimes.find((item) => item.id === runtimeId);
  if (!runtime) {
    return <span className="truncate text-muted-foreground">{t(($) => $.drafts.card_no_runtime)}</span>;
  }
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          runtime.status === "online" ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="truncate">{runtimeDisplayLabel(runtime)}</span>
    </>
  );
}

/** Work the draft cannot carry, for the owner to do once the agent exists. */
function FollowUps({ record }: { record: AgentDraftRecord }) {
  const { t } = useT("agents");
  if (record.follow_ups.length === 0) return null;
  return (
    <div className="border-t px-4 py-3">
      <div className="text-caption font-medium">{t(($) => $.drafts.follow_ups_title)}</div>
      <ul className="mt-2 space-y-1.5">
        {record.follow_ups.map((item, index) => (
          <li key={index} className="flex min-w-0 items-center gap-2 text-caption">
            <span
              aria-hidden="true"
              className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/60"
            />
            {item.kind === "env" ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0">{t(($) => $.drafts.follow_up_env)}</span>
                <code className="truncate rounded border bg-muted/60 px-1 font-mono text-micro">
                  {item.label}
                </code>
              </span>
            ) : (
              <span className="min-w-0 truncate">{item.label}</span>
            )}
            {item.hint ? (
              <span className="min-w-0 truncate text-muted-foreground">· {item.hint}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "info" | "warning" | "success" | "muted";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-micro font-medium",
        tone === "info" && "bg-info/10 text-info",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "success" && "bg-success/10 text-success",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function CardShell({ children, liveDraftId }: { children: ReactNode; liveDraftId?: string }) {
  return (
    <div
      data-agent-draft-card=""
      data-agent-draft-live={liveDraftId}
      className="not-prose my-2 w-full max-w-2xl overflow-hidden rounded-lg border bg-card"
    >
      {children}
    </div>
  );
}
