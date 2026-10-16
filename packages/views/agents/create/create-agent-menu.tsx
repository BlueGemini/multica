"use client";

import { ChevronDown, Copy, Info, Plus, SquarePen } from "lucide-react";
import type { AgentCreateMethod } from "@multica/core/agents/stores";
import type { ReactNode } from "react";
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
import { Kbd } from "@multica/ui/components/ui/kbd";
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
        <DropdownMenuContent align="end" className="w-80 p-1.5">
          {helper ? (
            <DropdownMenuItem className="gap-3 py-2" onClick={() => onCreate("chat")}>
              <MenuTile>
                <ActorAvatar
                  name={helper.name}
                  initials={helper.name.slice(0, 1).toUpperCase()}
                  avatarUrl={helper.avatar_url}
                  isAgent
                  size="xs"
                />
              </MenuTile>
              <MenuText
                title={t(($) => $.drafts.with_agent, { name: helper.name })}
                hint={t(($) => $.drafts.with_agent_hint, { name: helper.name })}
              />
              {primary === "chat" ? <Kbd className="ml-auto">↵</Kbd> : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="gap-3 py-2" onClick={() => onCreate("form")}>
            <MenuTile>
              <SquarePen className="size-3.5" />
            </MenuTile>
            <MenuText
              title={t(($) => $.drafts.manual)}
              hint={t(($) => $.drafts.manual_hint)}
            />
            {primary === "form" ? <Kbd className="ml-auto">↵</Kbd> : null}
          </DropdownMenuItem>
          {duplicateSources.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-3 py-2">
                <MenuTile>
                  <Copy className="size-3.5" />
                </MenuTile>
                <MenuText
                  title={t(($) => $.drafts.duplicate)}
                  hint={t(($) => $.drafts.duplicate_hint)}
                />
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
          ) : null}
          <DropdownMenuSeparator />
          <p className="flex items-center gap-1.5 px-2 py-1 text-caption text-muted-foreground">
            <Info aria-hidden="true" className="size-3.5 shrink-0" />
            {t(($) => $.drafts.menu_footer)}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MenuTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground">
      {children}
    </span>
  );
}

function MenuText({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-body font-medium">{title}</span>
      <span className="block text-caption leading-5 text-muted-foreground">
        {hint}
      </span>
    </span>
  );
}
