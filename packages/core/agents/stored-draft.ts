import type { AgentDraftConfig } from "../types";
import { EMPTY_AGENT_DRAFT, type AgentDraft } from "./draft";

export type { AgentDraftConfig };

export function toAgentDraftConfig(draft: AgentDraft): AgentDraftConfig {
  return {
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    conversation_starters: draft.conversationStarters,
    avatar_url: draft.avatarUrl,
    runtime_id: draft.runtimeId,
    model: draft.model,
    thinking_level: draft.thinkingLevel,
    service_tier: draft.serviceTier,
    skill_ids: [...draft.skillIds],
    permission_scope: draft.permissionScope,
    member_ids: [...draft.memberIds],
    team_ids: [...draft.teamIds],
  };
}

export function fromAgentDraftConfig(config: AgentDraftConfig): AgentDraft {
  return {
    ...EMPTY_AGENT_DRAFT,
    name: config.name,
    description: config.description,
    instructions: config.instructions,
    conversationStarters: config.conversation_starters ?? [],
    avatarUrl: config.avatar_url,
    runtimeId: config.runtime_id,
    model: config.model,
    thinkingLevel: config.thinking_level,
    serviceTier: config.service_tier,
    skillIds: new Set(config.skill_ids),
    permissionScope: config.permission_scope,
    memberIds: new Set(config.member_ids),
    teamIds: new Set(config.team_ids),
  };
}

/**
 * The fields of `next` that differ from `base`, ready for a field-merge PATCH.
 * Sending only these is what lets a member and an agent edit different fields
 * of the same draft without overwriting each other. Compared by serialized
 * value so a `Set` rebuilt with the same members is not an edit.
 */
export function diffAgentDraftConfig(
  base: AgentDraftConfig,
  next: AgentDraftConfig,
): Partial<AgentDraftConfig> {
  const changed: Partial<AgentDraftConfig> = {};
  for (const key of Object.keys(next) as (keyof AgentDraftConfig)[]) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) {
      (changed as Record<string, unknown>)[key] = next[key];
    }
  }
  return changed;
}

/**
 * Folds a newer server copy into the draft being edited. A field the user has
 * not touched since `base` (the last server copy they saw) takes the server's
 * value — that is another author's edit arriving. A field they have changed
 * keeps their value until it is saved.
 */
export function mergeRemoteAgentDraft(
  local: AgentDraft,
  base: AgentDraftConfig,
  server: AgentDraftConfig,
): AgentDraft {
  const localConfig = toAgentDraftConfig(local);
  const merged: Record<string, unknown> = { ...localConfig };
  for (const key of Object.keys(server) as (keyof AgentDraftConfig)[]) {
    if (JSON.stringify(localConfig[key]) === JSON.stringify(base[key])) {
      merged[key] = server[key];
    }
  }
  return fromAgentDraftConfig(merged as unknown as AgentDraftConfig);
}
