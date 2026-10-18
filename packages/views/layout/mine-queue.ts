import { queryOptions } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { InboxItem, Issue, IssueStatus } from "@multica/core/types";

/** Ordered by how much the issue is waiting on the user. */
export const MINE_QUEUE_GROUPS = ["review", "mentioned", "blocked", "assigned"] as const;
export type MineQueueGroup = (typeof MINE_QUEUE_GROUPS)[number];

export type MineQueueReason =
  | "review"
  | "review_requested"
  | "mentioned"
  | "blocked"
  | "blocked_by"
  | "in_progress"
  | "todo";

export interface MineQueueItem {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  issue: Issue | null;
  reason: MineQueueReason;
  actor: { type: "member" | "agent"; id: string } | null;
  at: string;
}

export interface MineQueueSources {
  /** Issues the user created that sit in review or are blocked. */
  created: Issue[];
  /** Issues assigned to the user that are open. */
  assigned: Issue[];
  /** The user's inbox. */
  inbox: InboxItem[];
}

const CREATED_STATUSES: IssueStatus[] = ["in_review", "blocked"];
const ASSIGNED_STATUSES: IssueStatus[] = ["blocked", "todo", "in_progress"];
const CLOSED_STATUSES: (IssueStatus | null)[] = ["done", "cancelled"];
const QUEUE_SOURCE_LIMIT = 50;

/** Server-side halves of the queue; the inbox half comes from the inbox cache. */
export function mineQueueOptions(wsId: string, userId: string) {
  return queryOptions({
    // Under tableAll so every issue mutation and realtime event refetches it;
    // the readers of that prefix skip caches without `rows`.
    queryKey: [...issueKeys.tableAll(wsId), "mine-queue", userId] as const,
    queryFn: async () => {
      const [created, assigned] = await Promise.all([
        api.listIssues({ creator_id: userId, statuses: CREATED_STATUSES, limit: QUEUE_SOURCE_LIMIT }),
        api.listIssues({ assignee_id: userId, statuses: ASSIGNED_STATUSES, limit: QUEUE_SOURCE_LIMIT }),
      ]);
      return { created: created.issues, assigned: assigned.issues };
    },
  });
}

function assigneeOf(issue: Issue): MineQueueItem["actor"] {
  if (issue.assignee_type === "member" || issue.assignee_type === "agent") {
    return issue.assignee_id ? { type: issue.assignee_type, id: issue.assignee_id } : null;
  }
  return null;
}

function issueItem(issue: Issue, reason: MineQueueReason, actor: MineQueueItem["actor"]): MineQueueItem {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    issue,
    reason,
    actor,
    at: issue.updated_at,
  };
}

function inboxItem(item: InboxItem & { issue_id: string }, reason: MineQueueReason): MineQueueItem {
  const actor =
    item.actor_type === "member" || item.actor_type === "agent"
      ? item.actor_id
        ? { type: item.actor_type, id: item.actor_id }
        : null
      : null;
  return {
    issueId: item.issue_id,
    identifier: null,
    title: item.title,
    status: item.issue_status ?? "todo",
    issue: null,
    reason,
    actor,
    at: item.created_at,
  };
}

const byNewest = (a: MineQueueItem, b: MineQueueItem) => b.at.localeCompare(a.at);

/**
 * What needs the user, grouped by why. An issue shows once, in the first
 * group that claims it: a delivered issue that also mentions the user is a
 * review, not a mention.
 */
export function buildMineQueue(
  userId: string,
  { created, assigned, inbox }: MineQueueSources,
): { group: MineQueueGroup; items: MineQueueItem[] }[] {
  const isMine = (issue: Issue) => issue.assignee_type === "member" && issue.assignee_id === userId;
  const pending = inbox.filter(
    (item): item is InboxItem & { issue_id: string } =>
      !item.read && !item.archived && !!item.issue_id && !CLOSED_STATUSES.includes(item.issue_status),
  );

  const candidates: Record<MineQueueGroup, MineQueueItem[]> = {
    review: [
      ...created
        .filter((issue) => issue.status === "in_review" && !isMine(issue))
        .map((issue) => issueItem(issue, "review", assigneeOf(issue))),
      ...pending
        .filter((item) => item.type === "review_requested")
        .map((item) => inboxItem(item, "review_requested")),
    ].sort(byNewest),
    mentioned: pending
      .filter((item) => item.type === "mentioned")
      .map((item) => inboxItem(item, "mentioned"))
      .sort(byNewest),
    blocked: [
      ...assigned
        .filter((issue) => issue.status === "blocked")
        .map((issue) => issueItem(issue, "blocked", null)),
      ...created
        .filter((issue) => issue.status === "blocked" && !isMine(issue))
        .map((issue) => issueItem(issue, "blocked_by", assigneeOf(issue))),
    ].sort(byNewest),
    assigned: assigned
      .filter((issue) => issue.status === "in_progress" || issue.status === "todo")
      .map((issue) => issueItem(issue, issue.status === "in_progress" ? "in_progress" : "todo", null))
      .sort((a, b) => (a.reason === b.reason ? byNewest(a, b) : a.reason === "in_progress" ? -1 : 1)),
  };

  const seen = new Set<string>();
  return MINE_QUEUE_GROUPS.map((group) => ({
    group,
    items: candidates[group].filter((item) => {
      if (seen.has(item.issueId)) return false;
      seen.add(item.issueId);
      return true;
    }),
  })).filter((section) => section.items.length > 0);
}
