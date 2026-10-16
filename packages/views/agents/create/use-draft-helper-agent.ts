"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { isMikaAgent } from "@multica/core/onboarding";
import type { Agent } from "@multica/core/types";
import {
  agentListOptions,
  memberListOptions,
} from "@multica/core/workspace/queries";
import { canAssignAgent } from "../../issues/components/pickers/assignee-picker";

/**
 * The agent that drafts agents in chat — the workspace's Mika — when this
 * member may talk to it. Null hides every "create with Mika" entry instead of
 * sending the member to a chat that would refuse them.
 */
export function useDraftHelperAgent(): Agent | null {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const role = members.find((member) => member.user_id === userId)?.role;
  const helper = agents.find((agent) => isMikaAgent(agent) && !agent.archived_at);
  return helper && canAssignAgent(helper, userId, role) ? helper : null;
}
