"use client";

import { ChevronDown, Copy, FileText, MessageSquare, Plus } from "lucide-react";
import type { AgentCreateMethod } from "@multica/core/agents/stores";
import type { Agent } from "@multica/core/types";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

/**
 * "New agent" as a split button. The menu lists every way to create; the main
 * button repeats the last one picked, so a member who prefers the form clicks
 * once from then on. Without a drafting agent to talk to, "chat" is not
 * offered and the main button falls back to the form.
 */
export function CreateAgentMenu({
  method,
  helper,
  duplicateSources,
  onCreate,
  onDuplicate,
  variant = "outline",
  className,
}: {
  method: AgentCreateMethod;
  helper: Agent | null;
  duplicateSources: Agent[];
  onCreate: (method: AgentCreateMethod) => void;
  onDuplicate: (agentId: string) => void;
  variant?: "outline" | "default";
  className?: string;
}) {
  const { t } = useT("agents");
  const primary: AgentCreateMethod = method === "chat" && helper ? "chat" : "form";

  return (
    <div className={cn("flex items-center", className)}>
      <Button
        type="button"
        size="sm"
        variant={variant}
        className="h-8 gap-1 rounded-r-none px-2.5"
        aria-label={t(($) => $.page.new_agent)}
        onClick={() => onCreate(primary)}
      >
        <Plus aria-hidden="true" className="size-3.5" />
        <span className="hidden md:inline">{t(($) => $.page.new_agent)}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant={variant}
              className="h-8 w-7 rounded-l-none border-l-0 px-0"
              aria-label={t(($) => $.drafts.create_menu_aria)}
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-72">
          {helper ? (
            <DropdownMenuItem
              className="items-start"
              onClick={() => onCreate("chat")}
            >
              <MessageSquare className="mt-0.5 size-3.5" />
              <MenuText
                title={t(($) => $.drafts.with_agent, { name: helper.name })}
                hint={t(($) => $.drafts.with_agent_hint, { name: helper.name })}
              />
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="items-start" onClick={() => onCreate("form")}>
            <FileText className="mt-0.5 size-3.5" />
            <MenuText
              title={t(($) => $.drafts.manual)}
              hint={t(($) => $.drafts.manual_hint)}
            />
          </DropdownMenuItem>
          {duplicateSources.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Copy className="size-3.5" />
                  {t(($) => $.drafts.duplicate)}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-auto min-w-48 overflow-y-auto">
                  {duplicateSources.map((agent) => (
                    <DropdownMenuItem
                      key={agent.id}
                      onClick={() => onDuplicate(agent.id)}
                    >
                      <ActorAvatar
                        name={agent.name}
                        initials={agent.name.slice(0, 1).toUpperCase()}
                        avatarUrl={agent.avatar_url}
                        isAgent
                        size="sm"
                      />
                      <span className="min-w-0 truncate">{agent.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MenuText({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-body">{title}</span>
      <span className="block text-caption leading-5 text-muted-foreground">
        {hint}
      </span>
    </span>
  );
}
