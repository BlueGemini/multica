"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@multica/ui/components/ui/button";
import { useScrollFade } from "@multica/ui/hooks/use-scroll-fade";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@multica/ui/components/ui/sidebar";
import { useWorkspacePresenceMap } from "@multica/core/agents";
import { useModalStore } from "@multica/core/modals";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectListOptions } from "@multica/core/projects/queries";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { Agent, Project, ProjectStatus } from "@multica/core/types";
import { ActorAvatar } from "../common/actor-avatar";
import { useT } from "../i18n";
import { AppLink } from "../navigation";
import { ProjectIcon } from "../projects/components/project-icon";
import { routeIconForPath } from "./route-icon-components";
import { SidebarPanelHeader } from "./sidebar-list-slot";
import { isNavActive } from "./sidebar-modules";

export const NAV_ITEM_CLASS_NAME =
  "text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground";

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_AGENTS: Agent[] = [];

/** The scrolling area under a panel's header. */
export function PanelBody({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fadeStyle = useScrollFade(scrollRef, 24);
  return (
    <SidebarContent ref={scrollRef} style={fadeStyle}>
      {children}
    </SidebarContent>
  );
}

/** A panel row that links to a route, with its icon derived from the route. */
export function PanelNavItem({
  href,
  label,
  isActive,
  icon,
  trailing,
}: {
  href: string;
  label: string;
  isActive: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  const Icon = routeIconForPath(href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        render={<AppLink href={href} />}
        className={NAV_ITEM_CLASS_NAME}
      >
        {icon ?? <Icon />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PanelCount({ value }: { value: number }) {
  return <span className="ml-auto text-caption text-muted-foreground tabular-nums">{value}</span>;
}

// Planned work belongs beside work in flight; paused stays reachable from the
// full list, and closed projects only clutter a navigation panel.
const ACTIVE_PROJECT_ORDER: ProjectStatus[] = ["in_progress", "planned"];

export function ProjectsPanel({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { data: projects = EMPTY_PROJECTS } = useQuery({
    ...projectListOptions(wsId),
    enabled: !!wsId,
  });
  const activeProjects = useMemo(
    () =>
      projects
        .filter((project) => ACTIVE_PROJECT_ORDER.includes(project.status))
        .sort(
          (a, b) =>
            ACTIVE_PROJECT_ORDER.indexOf(a.status) - ACTIVE_PROJECT_ORDER.indexOf(b.status),
        ),
    [projects],
  );

  return (
    <>
      <SidebarPanelHeader title={t(($) => $.nav.projects)}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t(($) => $.sidebar.new_project)}
          title={t(($) => $.sidebar.new_project)}
          onClick={() => useModalStore.getState().open("create-project")}
        >
          <Plus />
        </Button>
      </SidebarPanelHeader>
      <PanelBody>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <PanelNavItem
                href={p.projects()}
                label={t(($) => $.sidebar.all_projects)}
                isActive={pathname === p.projects()}
                trailing={projects.length > 0 ? <PanelCount value={projects.length} /> : null}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {activeProjects.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t(($) => $.sidebar.active_projects)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {activeProjects.map((project) => {
                  const href = p.projectDetail(project.id);
                  return (
                    <PanelNavItem
                      key={project.id}
                      href={href}
                      label={project.title}
                      isActive={isNavActive(pathname, href)}
                      icon={<ProjectIcon project={project} size="sm" />}
                    />
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </PanelBody>
    </>
  );
}

export function TeamPanel({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { data: agents = EMPTY_AGENTS } = useQuery({
    ...agentListOptions(wsId),
    enabled: !!wsId,
  });
  const { byAgent } = useWorkspacePresenceMap(wsId);
  const running = useMemo(
    () =>
      agents.filter(
        (agent) => !agent.archived_at && byAgent.get(agent.id)?.workload === "working",
      ),
    [agents, byAgent],
  );

  const manage = [
    { href: p.agents(), label: t(($) => $.nav.agents) },
    { href: p.squads(), label: t(($) => $.nav.squads) },
    { href: p.autopilots(), label: t(($) => $.nav.autopilots) },
  ];
  const capabilities = [
    { href: p.skills(), label: t(($) => $.nav.skills) },
    { href: p.runtimes(), label: t(($) => $.nav.runtimes) },
    { href: p.usage(), label: t(($) => $.nav.usage) },
  ];

  return (
    <>
      <SidebarPanelHeader title={t(($) => $.sidebar.ai_team_group)} />
      <PanelBody>
        <SidebarGroup>
          <SidebarGroupLabel>
            <span>{t(($) => $.sidebar.running_label)}</span>
            {running.length > 0 && <PanelCount value={running.length} />}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {running.length === 0 ? (
              <p className="px-2 py-1.5 text-caption text-muted-foreground">
                {t(($) => $.sidebar.running_empty)}
              </p>
            ) : (
              <SidebarMenu className="gap-0.5">
                {running.map((agent) => {
                  const href = p.agentDetail(agent.id);
                  const presence = byAgent.get(agent.id);
                  return (
                    <PanelNavItem
                      key={agent.id}
                      href={href}
                      label={agent.name}
                      isActive={isNavActive(pathname, href)}
                      icon={
                        <ActorAvatar
                          actorType="agent"
                          actorId={agent.id}
                          name={agent.name}
                          avatarUrl={agent.avatar_url}
                          size="xs"
                          showStatusDot
                          profileLink={false}
                        />
                      }
                      trailing={
                        presence && presence.runningCount > 1 ? (
                          <PanelCount value={presence.runningCount} />
                        ) : null
                      }
                    />
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t(($) => $.sidebar.team_group)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {manage.map((item) => (
                <PanelNavItem
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  isActive={isNavActive(pathname, item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t(($) => $.sidebar.capabilities_group)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {capabilities.map((item) => (
                <PanelNavItem
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  isActive={isNavActive(pathname, item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </PanelBody>
    </>
  );
}

/** The number of agents with a task running right now, for the rail badge. */
export function useRunningAgentCount(wsId: string | undefined): number {
  const { byAgent } = useWorkspacePresenceMap(wsId);
  return useMemo(() => {
    let count = 0;
    for (const presence of byAgent.values()) {
      if (presence.workload === "working") count += 1;
    }
    return count;
  }, [byAgent]);
}
