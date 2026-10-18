import { describe, expect, it } from "vitest";
import type { InboxItem, Issue } from "@multica/core/types";
import { buildMineQueue } from "./mine-queue";

const ME = "user-me";

function issue(id: string, fields: Partial<Issue>): Issue {
  return {
    id,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    status: "todo",
    assignee_type: "agent",
    assignee_id: "agent-1",
    creator_type: "member",
    creator_id: ME,
    updated_at: "2026-10-01T00:00:00Z",
    ...fields,
  } as Issue;
}

function notification(id: string, fields: Partial<InboxItem>): InboxItem {
  return {
    id,
    type: "mentioned",
    issue_id: `i-${id}`,
    title: `Issue i-${id}`,
    issue_status: "in_progress",
    actor_type: "member",
    actor_id: "user-2",
    read: false,
    archived: false,
    created_at: "2026-10-01T00:00:00Z",
    ...fields,
  } as InboxItem;
}

const groupsOf = (queue: ReturnType<typeof buildMineQueue>) =>
  Object.fromEntries(queue.map((s) => [s.group, s.items.map((i) => [i.issueId, i.reason])]));

describe("buildMineQueue", () => {
  it("groups issues by what they wait on the user for", () => {
    const queue = buildMineQueue(ME, {
      created: [
        issue("r", { status: "in_review" }),
        issue("b", { status: "blocked" }),
      ],
      assigned: [
        issue("t", { status: "todo", assignee_type: "member", assignee_id: ME }),
        issue("p", { status: "in_progress", assignee_type: "member", assignee_id: ME }),
        issue("x", { status: "blocked", assignee_type: "member", assignee_id: ME }),
      ],
      inbox: [
        notification("m", { type: "mentioned" }),
        notification("q", { type: "review_requested" }),
      ],
    });

    expect(queue.map((s) => s.group)).toEqual(["review", "mentioned", "blocked", "assigned"]);
    expect(groupsOf(queue)).toEqual({
      review: [["r", "review"], ["i-q", "review_requested"]],
      mentioned: [["i-m", "mentioned"]],
      blocked: [["x", "blocked"], ["b", "blocked_by"]],
      assigned: [["p", "in_progress"], ["t", "todo"]],
    });
    expect(queue[0]!.items[0]!.actor).toEqual({ type: "agent", id: "agent-1" });
  });

  it("shows an issue once, in the first group that claims it", () => {
    const queue = buildMineQueue(ME, {
      created: [issue("r", { status: "in_review" })],
      assigned: [],
      inbox: [notification("dup", { type: "mentioned", issue_id: "r" })],
    });
    expect(groupsOf(queue)).toEqual({ review: [["r", "review"]] });
  });

  it("skips what no longer needs the user", () => {
    const queue = buildMineQueue(ME, {
      // Self-assigned review: nobody delivered it to the user.
      created: [issue("self", { status: "in_review", assignee_type: "member", assignee_id: ME })],
      assigned: [],
      inbox: [
        notification("read", { read: true }),
        notification("archived", { archived: true }),
        notification("closed", { issue_status: "done" }),
        notification("comment", { type: "new_comment" }),
        notification("orphan", { issue_id: null }),
      ],
    });
    expect(queue).toEqual([]);
  });
});
