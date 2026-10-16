"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { pendingAgentDraftsOptions } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import type { AgentDraftRecord } from "@multica/core/types";
import { agentListOptions } from "@multica/core/workspace/queries";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { DiscardAgentDraftDialog } from "./agent-draft-actions";
import { liveAgentDraftCardSelector } from "./agent-draft-dom";
import { useDirectCreateDraft } from "./use-direct-create-draft";

// Loaded on first use: the dialog carries the whole agent editor, which a chat
// would otherwise pay for on every open.
const AgentDraftDialog = lazy(() =>
  import("./agent-draft-dialog").then((module) => ({ default: module.AgentDraftDialog })),
);

/**
 * Keeps the newest draft proposed in this chat within reach once its card has
 * scrolled away, so the conversation can move on without losing it.
 */
export function PinnedAgentDraftBar({
  sessionId,
  gutterClassName,
  columnClassName,
}: {
  sessionId: string | null;
  /** The host's column geometry, so the bar lines up with its composer. */
  gutterClassName?: string;
  columnClassName?: string;
}) {
  const wsId = useWorkspaceId();
  const { data: drafts = [] } = useQuery({
    ...pendingAgentDraftsOptions(wsId),
    enabled: !!sessionId,
  });
  const draft = sessionId
    ? drafts
        .filter((item) => item.source_chat_session_id === sessionId)
        .reduce<AgentDraftRecord | null>(
          (latest, item) => (!latest || item.updated_at > latest.updated_at ? item : latest),
          null,
        )
    : null;
  const cardInView = useElementInView(draft ? liveAgentDraftCardSelector(draft.id) : null);
  if (!draft || cardInView) return null;
  return (
    <PinnedBar
      key={draft.id}
      draft={draft}
      gutterClassName={gutterClassName}
      columnClassName={columnClassName}
    />
  );
}

function PinnedBar({
  draft,
  gutterClassName,
  columnClassName,
}: {
  draft: AgentDraftRecord;
  gutterClassName?: string;
  columnClassName?: string;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const direct = useDirectCreateDraft(draft);
  const [reviewing, setReviewing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => {
    if (direct.error) toast.error(direct.error);
  }, [direct.error]);

  const name = draft.config.name.trim() || t(($) => $.drafts.untitled);
  const author =
    draft.author_type === "agent"
      ? agents.find((agent) => agent.id === draft.author_id)?.name ?? ""
      : null;

  return (
    <div className={cn("pb-1.5", gutterClassName)}>
      <div
        data-pinned-agent-draft=""
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 shadow-sm",
          columnClassName,
        )}
      >
        <ActorAvatar
          name={name}
          initials={name.slice(0, 1).toUpperCase()}
          avatarUrl={draft.config.avatar_url}
          isAgent
          size="xs"
        />
        <span className="min-w-0 truncate text-caption font-medium">{name}</span>
        <span className="shrink-0 rounded bg-warning/15 px-1.5 py-px text-micro font-medium text-warning">
          {t(($) => $.drafts.pinned_badge)}
        </span>
        <span className="hidden min-w-0 truncate text-caption text-muted-foreground @md:inline">
          {draft.revision > 0
            ? `${t(($) => $.drafts.card_revision, { count: draft.revision })} · `
            : ""}
          {t(($) => $.drafts.pinned_hint)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setRejecting(true)}
          >
            {author !== null ? t(($) => $.drafts.reject) : t(($) => $.drafts.discard)}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => setReviewing(true)}>
            {t(($) => $.drafts.expand_review)}
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={direct.creating}
            onClick={() => {
              if (direct.ready) void direct.create();
              else setReviewing(true);
            }}
          >
            {direct.creating ? <Loader2 className="size-3 animate-spin" /> : null}
            {t(($) => $.drafts.create)}
          </Button>
        </div>
      </div>
      {reviewing ? (
        <Suspense fallback={null}>
          <AgentDraftDialog
            open
            onOpenChange={setReviewing}
            draftId={draft.id}
            navigateOnCreate={false}
          />
        </Suspense>
      ) : null}
      <DiscardAgentDraftDialog
        draftId={draft.id}
        open={rejecting}
        onOpenChange={setRejecting}
        authorName={author}
      />
    </div>
  );
}

/**
 * Whether any element matching `selector` is on screen. Elements come and go
 * as messages stream in and lists virtualize, so the set is re-read after DOM
 * changes, at most once a frame.
 */
function useElementInView(selector: string | null): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!selector || typeof IntersectionObserver === "undefined") {
      setInView(false);
      return;
    }
    const visible = new Set<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      setInView(visible.size > 0);
    });
    let observed: Element[] = [];
    let frame = 0;
    const sync = () => {
      frame = 0;
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length === observed.length && found.every((el, i) => el === observed[i])) return;
      observer.disconnect();
      visible.clear();
      observed = found;
      found.forEach((el) => observer.observe(el));
      if (found.length === 0) setInView(false);
    };
    sync();
    const mutations = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(sync);
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
    };
  }, [selector]);
  return inView;
}
