"use client";

import { Bot, SquarePen, X } from "lucide-react";
import { useWorkspacePaths } from "@multica/core/paths";
import type { Agent } from "@multica/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

/**
 * "This chat is for creating an agent." The goal reaches the agent as a line
 * at the top of the first message, so what the agent reads is what the member
 * sees; removing the chip before sending drops it.
 */
export function CreateAgentGoalChip({ onRemove }: { onRemove: () => void }) {
  const { t } = useT("chat");
  return (
    <div className="flex h-10 shrink-0 items-center border-b px-4">
      <span className="inline-flex h-6 items-center gap-1 rounded-full border bg-muted/40 pl-2 pr-1 text-caption text-muted-foreground">
        <Bot aria-hidden="true" className="size-3.5" />
        {t(($) => $.create_agent_goal.chip)}
        <button
          type="button"
          aria-label={t(($) => $.create_agent_goal.remove)}
          onClick={onRemove}
          className="grid size-4 place-items-center rounded-full hover:bg-muted hover:text-foreground"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      </span>
    </div>
  );
}

export function CreateAgentGoalEmptyState({ agent }: { agent: Agent | null }) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();
  const name = agent?.name ?? "";
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-4 overflow-y-auto px-6 py-8">
      {agent ? (
        <ActorAvatar
          actorType="agent"
          actorId={agent.id}
          size="2xl"
          className="ring-1 ring-inset ring-border"
        />
      ) : null}
      <div className="max-w-md space-y-1 text-center">
        <h3 className="text-title-sm font-semibold">{t(($) => $.create_agent_goal.title)}</h3>
        <p className="text-body text-muted-foreground">
          {t(($) => $.create_agent_goal.description, { name })}
        </p>
      </div>
      <AppLink
        href={paths.createAgent()}
        className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
      >
        <SquarePen aria-hidden="true" className="size-3.5" />
        {t(($) => $.create_agent_goal.manual)}
      </AppLink>
    </div>
  );
}
