import type { ChatSession } from "@multica/core/types";

export const FDE_SESSION_PREFIX = "FDE · ";

export interface FdeBrief {
  company: string;
  industry: string;
  footprint: string;
  collaboration: string;
  context: string;
}

export function fdeSessionTitle(company: string): string {
  return `${FDE_SESSION_PREFIX}${company.trim()}`.slice(0, 100);
}

export function buildFdeBrief(instructions: string, brief: FdeBrief): string {
  const context = Object.fromEntries(
    Object.entries(brief).map(([key, value]) => [key, value.trim() || null]),
  );
  return `${instructions}\n\n${JSON.stringify(context, null, 2)}`;
}

// The server may rename a conversation after its first message. Never infer
// durable FDE membership from a title; show recent workspace conversations.
export function recentWorkspaceConversations(sessions: ChatSession[], workspaceId: string): ChatSession[] {
  return sessions
    .filter((session) =>
      session.workspace_id === workspaceId &&
      session.status === "active",
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);
}
