"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Inbox, Plus } from "lucide-react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multica/ui/components/ui/collapsible";
import { useScrollFade } from "@multica/ui/hooks/use-scroll-fade";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@multica/ui/components/ui/sidebar";
import { useWorkspacePresenceMap } from "@multica/core/agents";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { autopilotListOptions } from "@multica/core/autopilots/queries";
import { inboxListOptions, useInboxUnreadCount } from "@multica/core/inbox/queries";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { issueKeys } from "@multica/core/issues/queries";
import { useModalStore } from "@multica/core/modals";
import { useWorkspacePaths } from "@multica/core/paths";
import { projectListOptions } from "@multica/core/projects/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import { agentListOptions, memberListOptions, squadListOptions } from "@multica/core/workspace/queries";
import type { Agent, Autopilot, InboxItem, Issue, MemberWithUser, Project, ProjectStatus, Squad } from "@multica/core/types";
import { ActorAvatar } from "../common/actor-avatar";
import { useT } from "../i18n";
import { useTimeAgo } from "../inbox/components/inbox-list-item";
import { StatusIcon } from "../issues/components/status-icon";
import { AppLink, useNavigation } from "../navigation";
import { ProjectIcon } from "../projects/components/project-icon";
import { buildMineQueue, mineQueueOptions, type MineQueueGroup, type MineQueueItem } from "./mine-queue";
import { routeIconForPath } from "./route-icon-components";
import { SidebarPanelHeader } from "./sidebar-list-slot";
import { isNavActive } from "./sidebar-modules";

export const NAV_ITEM_CLASS_NAME =
  "text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground";

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_AGENTS: Agent[] = [];
const EMPTY_SQUADS: Squad[] = [];
const EMPTY_MEMBERS: MemberWithUser[] = [];
const EMPTY_AUTOPILOTS: Autopilot[] = [];
const EMPTY_INBOX: InboxItem[] = [];
const EMPTY_ISSUES: Issue[] = [];

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

/** A group heading; with `href` it leads to the full list the group previews. */
function PanelGroupLabel({ label, href, count }: { label: string; href?: string; count?: number }) {
  const content = (
    <>
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 ? (
        <span className="ml-1.5 tabular-nums text-faint-foreground">{count}</span>
      ) : null}
    </>
  );
  if (!href) return <SidebarGroupLabel>{content}</SidebarGroupLabel>;
  return (
    <SidebarGroupLabel
      render={<AppLink href={href} />}
      className="hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
    >
      {content}
    </SidebarGroupLabel>
  );
}

// --- Mine -------------------------------------------------------------------

/** The Mine queue for the current user, shared by the panel and its header. */
export function useMineQueue(wsId: string) {
  const userId = useAuthStore((s) => s.user?.id) ?? "";
  const { data: issues, isPending } = useQuery({
    ...mineQueueOptions(wsId, userId),
    enabled: !!wsId && !!userId,
  });
  const { data: inbox = EMPTY_INBOX } = useQuery({ ...inboxListOptions(wsId), enabled: !!wsId });
  const sections = useMemo(
    () =>
      buildMineQueue(userId, {
        created: issues?.created ?? EMPTY_ISSUES,
        assigned: issues?.assigned ?? EMPTY_ISSUES,
        inbox,
      }),
    [userId, issues, inbox],
  );
  const count = sections.reduce((sum, section) => sum + section.items.length, 0);
  return { sections, count, isPending };
}

const MINE_TAB_CLASS_NAME =
  "flex h-7 items-center gap-1.5 rounded-md px-2 text-body text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground";

/**
 * Mine's two views: what needs the user, and everything that happened. The
 * Inbox page renders this into its list column so both views share a header.
 */
export function MinePanelHeader({
  wsId,
  active,
  children,
}: {
  wsId: string;
  active: "queue" | "activity";
  children?: ReactNode;
}) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { count } = useMineQueue(wsId);
  const unread = useInboxUnreadCount(wsId);
  const tabs = [
    { key: "queue", href: p.myIssues(), label: t(($) => $.mine.tab_queue), count },
    { key: "activity", href: p.inbox(), label: t(($) => $.mine.tab_activity), count: unread },
  ] as const;
  return (
    <header
      data-slot="sidebar-panel-header"
      className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-2"
    >
      <nav aria-label={t(($) => $.rail.mine)} className="flex min-w-0 flex-1 items-center gap-0.5">
        {tabs.map((tab) => (
          <AppLink
            key={tab.key}
            href={tab.href}
            data-active={tab.key === active ? "" : undefined}
            aria-current={tab.key === active ? "page" : undefined}
            className={MINE_TAB_CLASS_NAME}
          >
            <span className="truncate">{tab.label}</span>
            {tab.count > 0 ? (
              <span className="text-caption tabular-nums text-muted-foreground">
                {tab.count > 99 ? "99+" : tab.count}
              </span>
            ) : null}
          </AppLink>
        ))}
      </nav>
      {children}
    </header>
  );
}

function useMineGroupLabel() {
  const { t } = useT("layout");
  return (group: MineQueueGroup) => {
    switch (group) {
      case "review":
        return t(($) => $.mine.group_review);
      case "mentioned":
        return t(($) => $.mine.group_mentioned);
      case "blocked":
        return t(($) => $.mine.group_blocked);
      case "assigned":
        return t(($) => $.mine.group_assigned);
    }
  };
}

function MineQueueRow({ item, wsId, pathname }: { item: MineQueueItem; wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const statusCatalog = useIssueStatuses(wsId);
  const { getActorName } = useActorName();
  const timeAgo = useTimeAgo();
  const href = p.issueDetail(item.issueId);
  const name = item.actor ? getActorName(item.actor.type, item.actor.id) : t(($) => $.mine.someone);
  const reason = (() => {
    switch (item.reason) {
      case "review":
        return item.actor
          ? t(($) => $.mine.reason_review, { name })
          : t(($) => $.mine.reason_review_pending);
      case "review_requested":
        return t(($) => $.mine.reason_review_requested, { name });
      case "mentioned":
        return t(($) => $.mine.reason_mentioned, { name });
      case "blocked":
        return t(($) => $.mine.reason_blocked);
      case "blocked_by":
        return t(($) => $.mine.reason_blocked_by, { name });
      case "in_progress":
        return t(($) => $.mine.reason_in_progress);
      case "todo":
        return t(($) => $.mine.reason_todo);
    }
  })();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={pathname === href}
        render={<AppLink href={href} />}
        className={cn(NAV_ITEM_CLASS_NAME, "h-auto items-start gap-2.5 py-2")}
      >
        <StatusIcon
          status={item.status}
          color={statusCatalog.colorOf(item.status)}
          icon={statusCatalog.iconOf(item.status)}
          category={statusCatalog.categoryOf(item.status)}
          className="mt-0.5 !size-3.5 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-foreground">{item.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption font-normal text-muted-foreground">
            {item.actor ? (
              <ActorAvatar
                actorType={item.actor.type}
                actorId={item.actor.id}
                size="xs"
                profileLink={false}
                className="!size-3.5"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{reason}</span>
            <span className="shrink-0 tabular-nums text-faint-foreground">{timeAgo(item.at)}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function MinePanel({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const groupLabel = useMineGroupLabel();
  const { sections, isPending } = useMineQueue(wsId);

  return (
    <>
      <MinePanelHeader wsId={wsId} active="queue" />
      <PanelBody>
        {sections.map((section) => (
          <SidebarGroup key={section.group}>
            <PanelGroupLabel label={groupLabel(section.group)} count={section.items.length} />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {section.items.map((item) => (
                  <MineQueueRow key={item.issueId} item={item} wsId={wsId} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        {!isPending && sections.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-12 text-center">
            <Inbox className="h-8 w-8 text-faint-foreground" />
            <p className="text-body text-foreground">{t(($) => $.mine.empty_title)}</p>
            <p className="text-caption text-muted-foreground">{t(($) => $.mine.empty_hint)}</p>
          </div>
        ) : null}
      </PanelBody>
    </>
  );
}

// --- Work -------------------------------------------------------------------

// Planned work belongs beside work in flight; paused stays reachable from the
// full list, and closed projects only clutter a navigation panel.
const ACTIVE_PROJECT_ORDER: ProjectStatus[] = ["in_progress", "planned"];
const PROJECT_ISSUE_PREVIEW_LIMIT = 8;
const AUTOPILOT_PREVIEW_LIMIT = 5;

function projectOpenIssuesOptions(wsId: string, projectId: string) {
  return queryOptions({
    // Under tableAll so issue mutations and realtime events refetch it.
    queryKey: [...issueKeys.tableAll(wsId), "sidebar-project", projectId] as const,
    queryFn: async () => {
      const res = await api.listIssues({
        project_id: projectId,
        open_only: true,
        limit: PROJECT_ISSUE_PREVIEW_LIMIT + 1,
      });
      return { issues: res.issues };
    },
  });
}

function ProjectTreeItem({ project, wsId, pathname }: { project: Project; wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const statusCatalog = useIssueStatuses(wsId);
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ ...projectOpenIssuesOptions(wsId, project.id), enabled: open });
  const href = p.projectDetail(project.id);
  const issues = data?.issues ?? EMPTY_ISSUES;

  return (
    <SidebarMenuItem>
      <Collapsible open={open} onOpenChange={setOpen}>
        <SidebarMenuButton
          isActive={isNavActive(pathname, href)}
          render={<AppLink href={href} />}
          className={NAV_ITEM_CLASS_NAME}
        >
          <ProjectIcon project={project} size="sm" />
          <span className="min-w-0 flex-1 truncate">{project.title}</span>
        </SidebarMenuButton>
        <SidebarMenuAction
          render={<CollapsibleTrigger />}
          showOnHover
          aria-label={project.title}
          className="text-muted-foreground [&[data-panel-open]>svg]:rotate-90"
        >
          <ChevronRight className="!size-3.5 transition-transform duration-150" />
        </SidebarMenuAction>
        <CollapsibleContent>
          {data ? (
            <SidebarMenuSub className="mr-0 gap-0.5">
              {issues.length === 0 ? (
                <li className="px-2 py-1 text-caption text-faint-foreground">
                  {t(($) => $.work.no_open_issues)}
                </li>
              ) : (
                issues.slice(0, PROJECT_ISSUE_PREVIEW_LIMIT).map((issue) => {
                  const issueHref = p.issueDetail(issue.id);
                  return (
                    <SidebarMenuSubItem key={issue.id}>
                      <SidebarMenuSubButton
                        isActive={pathname === issueHref}
                        render={<AppLink href={issueHref} />}
                        className="text-muted-foreground"
                      >
                        <StatusIcon
                          status={issue.status}
                          color={statusCatalog.colorOf(issue.status)}
                          icon={statusCatalog.iconOf(issue.status)}
                          category={statusCatalog.categoryOf(issue.status)}
                          className="!size-3.5 shrink-0"
                        />
                        <span>{issue.title}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  );
                })
              )}
              {issues.length > PROJECT_ISSUE_PREVIEW_LIMIT ? (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    size="sm"
                    render={<AppLink href={href} />}
                    className="text-muted-foreground"
                  >
                    <span>{t(($) => $.work.view_all)}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ) : null}
            </SidebarMenuSub>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

/** Active projects as a tree; each opens to its unfinished issues. */
export function WorkProjectsGroup({ wsId, pathname }: { wsId: string; pathname: string }) {
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
    <SidebarGroup>
      <PanelGroupLabel label={t(($) => $.nav.projects)} href={p.projects()} count={projects.length} />
      <SidebarGroupAction
        aria-label={t(($) => $.sidebar.new_project)}
        title={t(($) => $.sidebar.new_project)}
        className="text-muted-foreground"
        onClick={() => useModalStore.getState().open("create-project")}
      >
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {activeProjects.map((project) => (
            <ProjectTreeItem key={project.id} project={project} wsId={wsId} pathname={pathname} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Scheduled work: running autopilots first, paused ones after. */
export function WorkAutopilotsGroup({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { data: autopilots = EMPTY_AUTOPILOTS } = useQuery({
    ...autopilotListOptions(wsId),
    enabled: !!wsId,
  });
  const listed = useMemo(
    () =>
      autopilots
        .filter((autopilot) => autopilot.status !== "archived")
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)),
    [autopilots],
  );
  if (listed.length === 0) return null;

  return (
    <SidebarGroup>
      <PanelGroupLabel label={t(($) => $.nav.autopilots)} href={p.autopilots()} count={listed.length} />
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {listed.slice(0, AUTOPILOT_PREVIEW_LIMIT).map((autopilot) => {
            const href = p.autopilotDetail(autopilot.id);
            return (
              <PanelNavItem
                key={autopilot.id}
                href={href}
                label={autopilot.title}
                isActive={isNavActive(pathname, href)}
                trailing={
                  autopilot.status === "paused" ? (
                    <span className="ml-auto text-caption text-faint-foreground">
                      {t(($) => $.work.paused)}
                    </span>
                  ) : null
                }
              />
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// --- Team -------------------------------------------------------------------

export function TeamPanel({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const { push } = useNavigation();
  const { data: agents = EMPTY_AGENTS } = useQuery({ ...agentListOptions(wsId), enabled: !!wsId });
  const { data: squads = EMPTY_SQUADS } = useQuery({ ...squadListOptions(wsId), enabled: !!wsId });
  const { data: members = EMPTY_MEMBERS } = useQuery({ ...memberListOptions(wsId), enabled: !!wsId });
  const { byAgent } = useWorkspacePresenceMap(wsId);

  const { running, idle } = useMemo(() => {
    const live = agents.filter((agent) => !agent.archived_at);
    return {
      running: live.filter((agent) => byAgent.get(agent.id)?.workload === "working"),
      idle: live.filter((agent) => byAgent.get(agent.id)?.workload !== "working"),
    };
  }, [agents, byAgent]);
  const liveSquads = useMemo(() => squads.filter((squad) => !squad.archived_at), [squads]);

  const agentRow = (agent: Agent, trailing?: ReactNode) => {
    const href = p.agentDetail(agent.id);
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
        trailing={trailing}
      />
    );
  };

  return (
    <>
      <SidebarPanelHeader title={t(($) => $.rail.team)}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t(($) => $.team.new_agent)}
          title={t(($) => $.team.new_agent)}
          onClick={() => push(p.newAgent())}
        >
          <Plus />
        </Button>
      </SidebarPanelHeader>
      <PanelBody>
        {running.length > 0 && (
          <SidebarGroup>
            <PanelGroupLabel label={t(($) => $.sidebar.running_label)} count={running.length} />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {running.map((agent) => {
                  const presence = byAgent.get(agent.id);
                  return agentRow(
                    agent,
                    presence && presence.runningCount > 1 ? <PanelCount value={presence.runningCount} /> : null,
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <PanelGroupLabel label={t(($) => $.nav.agents)} href={p.agents()} count={idle.length} />
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">{idle.map((agent) => agentRow(agent))}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {liveSquads.length > 0 && (
          <SidebarGroup>
            <PanelGroupLabel label={t(($) => $.nav.squads)} href={p.squads()} count={liveSquads.length} />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {liveSquads.map((squad) => {
                  const href = p.squadDetail(squad.id);
                  return (
                    <PanelNavItem
                      key={squad.id}
                      href={href}
                      label={squad.name}
                      isActive={isNavActive(pathname, href)}
                      icon={
                        <ActorAvatar
                          actorType="squad"
                          actorId={squad.id}
                          name={squad.name}
                          avatarUrl={squad.avatar_url}
                          size="xs"
                          profileLink={false}
                        />
                      }
                    />
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {members.length > 0 && (
          <SidebarGroup>
            <PanelGroupLabel
              label={t(($) => $.team.members)}
              href={`${p.settings()}?tab=members`}
              count={members.length}
            />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {members.map((member) => {
                  const href = p.memberDetail(member.user_id);
                  return (
                    <PanelNavItem
                      key={member.user_id}
                      href={href}
                      label={member.name}
                      isActive={isNavActive(pathname, href)}
                      icon={
                        <ActorAvatar
                          actorType="member"
                          actorId={member.user_id}
                          name={member.name}
                          avatarUrl={member.avatar_url}
                          size="xs"
                          profileLink={false}
                        />
                      }
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
