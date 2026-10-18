"use client";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";

import { issueStatusCategory } from "@multica/core/issues";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import { HelpLauncher } from "./help-launcher";
import { JoinDiscordCard } from "./join-discord-card";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Layers,
  ChevronRight,
  LogOut,
  Plus,
  Check,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import { WorkspaceAvatar } from "../workspace/workspace-avatar";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multica/ui/components/ui/tooltip";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@multica/ui/components/ui/collapsible";
import { CappedNumberFlow } from "@multica/ui/components/ui/number-flow";
import { StatusIcon } from "../issues/components/status-icon";
import { useIssueDraftStore } from "@multica/core/issues/stores/draft-store";
import { openCreateIssueWithPreference } from "@multica/core/issues/stores/create-mode-store";
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@multica/ui/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useAuthStore } from "@multica/core/auth";
import { issueViewDetailOptions } from "@multica/core/issue-views/queries";
import {
  issueViewContainerKey,
  useActiveIssueViewStore,
} from "@multica/core/issue-views/active-view-store";
import { useCurrentWorkspace, useWorkspacePaths, paths } from "@multica/core/paths";
import { workspaceListOptions, myInvitationListOptions, workspaceKeys } from "@multica/core/workspace/queries";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { inboxUnreadSummaryOptions, useInboxUnreadCount, hasOtherWorkspaceUnread, unreadWorkspaceIds } from "@multica/core/inbox/queries";
import { chatSessionsOptions } from "@multica/core/chat/queries";
import { countUnreadChatMessages } from "@multica/core/chat/unread";
import { useChatStore } from "@multica/core/chat";
import { api, ApiError } from "@multica/core/api";
import { useConfigStore } from "@multica/core/config";
import { pinListOptions } from "@multica/core/pins/queries";
import { useDeletePin, useReorderPins } from "@multica/core/pins/mutations";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { projectDetailOptions } from "@multica/core/projects/queries";
import type { PinnedItem } from "@multica/core/types";
import { useLogout } from "../auth";
import { ProjectIcon } from "../projects/components/project-icon";
import { routeIconForPath } from "./route-icon-components";
import { useT } from "../i18n";
import {
  useShortcut,
} from "@multica/core/shortcuts";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { useAppForeground } from "../common/use-app-foreground";
import { useSearchStore } from "../search/search-store";
import { SidebarListSlot, SidebarPanelHeader } from "./sidebar-list-slot";
import {
  LIST_MODULES,
  SIDEBAR_MODULES,
  isNavActive,
  ownsSidebarRoute,
  resolveSidebarModule,
  sidebarModuleHome,
  type SidebarModule,
} from "./sidebar-modules";
import {
  NAV_ITEM_CLASS_NAME,
  PanelBody,
  PanelNavItem,
  ProjectsPanel,
  TeamPanel,
  useRunningAgentCount,
} from "./sidebar-panels";

// Stable empty arrays for query defaults. Using an inline `= []` default on
// `useQuery` creates a new array reference on every render when `data` is
// undefined (e.g. query disabled or loading) — which in turn breaks any
// `useEffect`/`useMemo` that depends on the value, and can trigger infinite
// re-render loops when the effect itself calls `setState`.
const EMPTY_PINS: PinnedItem[] = [];
const EMPTY_WORKSPACES: Awaited<ReturnType<typeof api.listWorkspaces>> = [];
const EMPTY_INVITATIONS: Awaited<ReturnType<typeof api.listMyInvitations>> = [];
const EMPTY_INBOX_SUMMARY: Awaited<ReturnType<typeof api.getInboxUnreadSummary>> = [];
const PINNED_PREVIEW_LIMIT = 5;

/**
 * Width bounds for the rail + panel sidebar, shared by every shell that
 * mounts `AppSidebar`. The expanded width covers the 48px rail, the panel,
 * and the inset variant's 8px padding on both sides; the panel's range
 * matches the list column Inbox and Chat used to keep in the page.
 */
export const APP_SIDEBAR_PROVIDER_PROPS = {
  defaultWidth: 324,
  minWidth: 284,
  maxWidth: 464,
  widthStorageKey: "sidebar_rail_width",
} as const;

const RAIL_ITEM_CLASS_NAME =
  "relative flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground [&_svg]:size-[18px] [&_svg]:shrink-0";

function DraftDot() {
  const hasDraft = useIssueDraftStore((s) => s.hasDraft());
  if (!hasDraft) return null;
  return <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" />;
}

function RailBadge({ value, label }: { value: number; label: string }) {
  if (value <= 0) return null;
  return (
    <span
      data-slot="rail-badge"
      aria-label={label}
      className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-micro leading-none font-medium text-brand-foreground ring-2 ring-sidebar"
    >
      <CappedNumberFlow value={value} animated={false} />
    </span>
  );
}

function RailTooltip({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Presentational pin row. The `label` and `iconNode` are computed by the
 * parent `PinRow` from cached issue / project detail queries — keeping
 * this component dumb means the dnd-kit / navigation wiring lives in
 * one place and the data flow is explicit.
 */
function SortablePinItem({
  pin,
  href,
  pathname,
  onUnpin,
  label,
  iconNode,
  onNavigate,
  isActiveOverride,
}: {
  pin: PinnedItem;
  href: string;
  pathname: string;
  onUnpin: () => void;
  label: string;
  iconNode: React.ReactNode;
  /** Runs on a real click (not a drag-release) before navigation. */
  onNavigate?: () => void;
  /** Overrides the plain path comparison (view pins carry extra state). */
  isActiveOverride?: boolean;
}) {
  const { t } = useT("layout");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pin.id });
  const wasDragged = useRef(false);

  useEffect(() => {
    if (isDragging) wasDragged.current = true;
  }, [isDragging]);

  const style = { transform: CSS.Transform.toString(transform), transition };
  const isActive = isActiveOverride ?? pathname === href;

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={style}
      className={cn("group/pin", isDragging && "opacity-30")}
      {...attributes}
      {...listeners}
    >
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        render={<AppLink href={href} newTabTitle={label} draggable={false} />}
        onClick={(event) => {
          if (wasDragged.current) {
            wasDragged.current = false;
            event.preventDefault();
            return;
          }
          onNavigate?.();
        }}
        className={cn(
          NAV_ITEM_CLASS_NAME,
          isDragging && "pointer-events-none",
        )}
      >
        {iconNode}
        <span
          className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
          style={{
            maskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
            WebkitMaskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
          }}
        >{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={<span role="button" />}
            className="hidden size-2.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground group-hover/pin:flex hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onUnpin();
            }}
          >
            <X className="size-1" />
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>{t(($) => $.sidebar.unpin_tooltip)}</TooltipContent>
        </Tooltip>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Smart wrapper that resolves a pin's display data (label + status/icon)
 * from the issue / project detail query cache. Both queries are declared
 * unconditionally with `enabled` gates so the hook order stays stable
 * regardless of `pin.item_type`.
 *
 * Loading: render a flat skeleton so the sidebar height doesn't jump.
 * Missing (deleted item / 404): render nothing — the row hides itself
 * until the user unpins manually or a server-side cascade catches up.
 */
function PinRow({
  pin,
  href,
  pathname,
  onUnpin,
  wsId,
}: {
  pin: PinnedItem;
  href: string;
  pathname: string;
  onUnpin: () => void;
  wsId: string;
}) {
  const isIssue = pin.item_type === "issue";
  const statusCatalog = useIssueStatuses(wsId);
  const isView = pin.item_type === "view";
  const p = useWorkspacePaths();
  const setActiveView = useActiveIssueViewStore((s) => s.setActive);
  const issueQuery = useQuery({
    ...issueDetailOptions(wsId, pin.item_id),
    enabled: isIssue,
  });
  const projectQuery = useQuery({
    ...projectDetailOptions(wsId, pin.item_id),
    enabled: pin.item_type === "project",
  });
  const viewQuery = useQuery({
    ...issueViewDetailOptions(wsId, pin.item_id),
    enabled: isView,
  });

  const triggeredRef = useRef(false);
  useEffect(() => {
    // Views are exempt from 404-auto-unpin: an installed desktop client
    // talking to an older backend without the view endpoints sees 404 for
    // every view pin — auto-unpinning would permanently delete them all.
    // A deleted view's row simply hides instead.
    if (isView) return;
    const err = isIssue ? issueQuery.error : projectQuery.error;
    if (err instanceof ApiError && err.status === 404 && !triggeredRef.current) {
      triggeredRef.current = true;
      onUnpin();
    }
  }, [isIssue, isView, issueQuery.error, onUnpin, projectQuery.error]);

  const activeViewByContainer = useActiveIssueViewStore((s) => s.active);
  if (isView) {
    if (viewQuery.isPending) return <PinSkeleton />;
    if (viewQuery.isError || !viewQuery.data) return null;
    const view = viewQuery.data;
    // One resolved scope drives the path AND the container key so an
    // unrecognised scope_type from a newer backend degrades coherently.
    const scopeType: "workspace" | "my" | "project" =
      view.scope_type === "my"
        ? "my"
        : view.scope_type === "project" && view.scope_id
          ? "project"
          : "workspace";
    const viewPath =
      scopeType === "my"
        ? p.myIssues()
        : scopeType === "project"
          ? p.projectDetail(view.scope_id!)
          : p.issues();
    const containerKey = issueViewContainerKey(wsId, {
      scope_type: scopeType,
      scope_id: scopeType === "project" ? view.scope_id : null,
    });
    return (
      <SortablePinItem
        pin={pin}
        // ?view= keeps a web reload on the view for the surfaces that mount
        // the URL-sync hook (/issues, /my-issues). Project pages don't sync
        // yet — there the query is inert and reload falls back to the plain
        // page; click-through activation still works everywhere.
        href={`${viewPath}?view=${view.id}`}
        pathname={pathname}
        onUnpin={onUnpin}
        label={view.name}
        iconNode={<Layers className="!size-3.5 shrink-0" />}
        // Active only when this exact view is open on its surface — the
        // path alone also matches the plain tab.
        isActiveOverride={
          pathname === viewPath && activeViewByContainer[containerKey] === view.id
        }
        onNavigate={() => setActiveView(containerKey, view.id)}
      />
    );
  }

  if (isIssue) {
    if (issueQuery.isPending) return <PinSkeleton />;
    if (issueQuery.isError || !issueQuery.data) return null;
    const issue = issueQuery.data;
    const label = issue.title;
    const iconNode = (
      /* Override parent [&_svg]:size-4 — pinned items need smaller icons to match sm size */
      <StatusIcon
        status={issue.status}
        color={statusCatalog.colorOf(issue.status)}
        icon={statusCatalog.iconOf(issue.status)}
        category={issueStatusCategory(issue) ?? undefined}
        className="!size-3.5 shrink-0"
      />
    );
    return (
      <SortablePinItem
        pin={pin}
        href={href}
        pathname={pathname}
        onUnpin={onUnpin}
        label={label}
        iconNode={iconNode}
      />
    );
  }

  if (projectQuery.isPending) return <PinSkeleton />;
  if (projectQuery.isError || !projectQuery.data) return null;
  const project = projectQuery.data;
  const iconNode = <ProjectIcon project={project} size="sm" />;
  return (
    <SortablePinItem
      pin={pin}
      href={href}
      pathname={pathname}
      onUnpin={onUnpin}
      label={project.title}
      iconNode={iconNode}
    />
  );
}

function PinSkeleton() {
  return (
    <SidebarMenuItem>
      <div className="flex h-7 w-full items-center gap-2 px-2">
        <div className="size-3.5 shrink-0 rounded-sm bg-sidebar-accent/40" />
        <div className="h-3 w-24 rounded-xs bg-sidebar-accent/40" />
      </div>
    </SidebarMenuItem>
  );
}

/** Tasks panel: the personal and workspace issue lists, then the user's pins. */
function IssuesPanel({ wsId, pathname }: { wsId: string; pathname: string }) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const userId = useAuthStore((s) => s.user?.id);
  const createIssueShortcut = useShortcut("createIssue");
  const { data: pinnedItems = EMPTY_PINS } = useQuery({
    ...pinListOptions(wsId, userId ?? ""),
    enabled: !!wsId && !!userId,
  });
  const deletePin = useDeletePin();
  const reorderPins = useReorderPins();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const getPinHref = useCallback(
    (pin: PinnedItem) =>
      pin.item_type === "issue"
        ? p.issueDetail(pin.item_id)
        : pin.item_type === "project"
          ? p.projectDetail(pin.item_id)
          // Views know their target only after their detail loads — the row
          // resolves its own href; this placeholder never renders as a link.
          : "",
    [p],
  );

  // Local presentational copy of pinnedItems for drop-animation stability.
  // Follows TQ at rest; frozen during a drag gesture so a mid-drag cache
  // write (our own optimistic update, or a WS refetch) cannot reorder the
  // DOM under dnd-kit while its drop animation is still interpolating.
  const [localPinned, setLocalPinned] = useState<PinnedItem[]>(pinnedItems);
  const [localPinnedWsId, setLocalPinnedWsId] = useState<string | null>(wsId);
  const [expandedPinsWorkspaceId, setExpandedPinsWorkspaceId] = useState<string | null>(null);
  const isDraggingRef = useRef(false);
  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalPinned(pinnedItems);
    }
  }, [pinnedItems]);
  useEffect(() => {
    setLocalPinnedWsId(wsId);
  }, [wsId]);
  const visiblePinned = localPinnedWsId === wsId ? localPinned : EMPTY_PINS;
  const pinsExpanded = expandedPinsWorkspaceId === wsId;
  const displayedPinned = pinsExpanded ? visiblePinned : visiblePinned.slice(0, PINNED_PREVIEW_LIMIT);
  // View pins are absent here (their href resolves async): while a view
  // pin is active the plain nav row for its surface stays highlighted too.
  // Accepted — suppressing it would need every view detail lifted up here.
  const isActivePinnedRoute = displayedPinned.some((pin) => pathname === getPinHref(pin));

  const handleDragStart = useCallback(() => {
    isDraggingRef.current = true;
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = localPinned.findIndex((p) => p.id === active.id);
      const newIndex = localPinned.findIndex((p) => p.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(localPinned, oldIndex, newIndex);
      setLocalPinned(reordered);
      reorderPins.mutate(reordered);
    },
    [localPinned, reorderPins],
  );

  return (
    <>
      <SidebarPanelHeader title={t(($) => $.nav.issues)} />
      <PanelBody>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-muted-foreground"
                  onClick={() => openCreateIssueWithPreference()}
                >
                  <span className="relative">
                    <SquarePen />
                    <DraftDot />
                  </span>
                  <span>{t(($) => $.sidebar.new_issue)}</span>
                  {createIssueShortcut ? (
                    <ShortcutKeycaps shortcut={createIssueShortcut} decorative className="pointer-events-none ml-auto" />
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <PanelNavItem
                href={p.myIssues()}
                label={t(($) => $.nav.my_issues)}
                isActive={isNavActive(pathname, p.myIssues())}
              />
              <PanelNavItem
                href={p.issues()}
                label={t(($) => $.sidebar.all_issues)}
                isActive={!isActivePinnedRoute && isNavActive(pathname, p.issues())}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {visiblePinned.length > 0 && (
          <Collapsible defaultOpen>
            <SidebarGroup className="group/pinned">
              <SidebarGroupLabel
                render={<CollapsibleTrigger />}
                className="group/trigger cursor-pointer hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
              >
                <span>{t(($) => $.sidebar.pinned_label)}</span>
                <ChevronRight className="!size-3 ml-1 stroke-[2.5] transition-transform duration-200 group-data-[panel-open]/trigger:rotate-90" />
                <span className="ml-auto text-micro text-muted-foreground opacity-0 transition-opacity group-hover/pinned:opacity-100">{visiblePinned.length}</span>
              </SidebarGroupLabel>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                    <SortableContext items={displayedPinned.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                      <SidebarMenu className="gap-0.5">
                        {displayedPinned.map((pin: PinnedItem) => (
                          <PinRow
                            key={pin.id}
                            pin={pin}
                            href={getPinHref(pin)}
                            pathname={pathname}
                            onUnpin={() => deletePin.mutate({ itemType: pin.item_type, itemId: pin.item_id })}
                            wsId={wsId}
                          />
                        ))}
                      </SidebarMenu>
                    </SortableContext>
                  </DndContext>
                  {visiblePinned.length > PINNED_PREVIEW_LIMIT && (
                    <SidebarMenuButton
                      size="sm"
                      aria-expanded={pinsExpanded}
                      className="mt-0.5 pl-7 text-muted-foreground"
                      onClick={() => setExpandedPinsWorkspaceId(pinsExpanded ? null : wsId)}
                    >
                      <span>
                        {pinsExpanded
                          ? t(($) => $.sidebar.show_fewer_pins)
                          : t(($) => $.sidebar.show_more_pins, { count: visiblePinned.length - PINNED_PREVIEW_LIMIT })}
                      </span>
                    </SidebarMenuButton>
                  )}
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        )}
      </PanelBody>
    </>
  );
}

/**
 * The workspace avatar at the top of the rail: switch workspaces, answer
 * invitations, log out.
 */
function WorkspaceMenu() {
  const { t } = useT("layout");
  const { push } = useNavigation();
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id;
  const { data: workspaces = EMPTY_WORKSPACES } = useQuery(workspaceListOptions());
  const { data: myInvitations = EMPTY_INVITATIONS } = useQuery(myInvitationListOptions());
  const workspaceCreationDisabled = useConfigStore((s) => s.workspaceCreationDisabled);
  // Cross-workspace unread summary backs the switcher dot. One shared cache
  // entry across workspaces; gated on an active workspace since the endpoint
  // resolves through the workspace-member middleware.
  const { data: unreadSummary = EMPTY_INBOX_SUMMARY } = useQuery({
    ...inboxUnreadSummaryOptions(),
    enabled: !!wsId,
  });
  const otherWorkspaceUnread = React.useMemo(
    () => hasOtherWorkspaceUnread(unreadSummary, wsId),
    [unreadSummary, wsId],
  );
  // Which workspaces have unread, so the switcher dropdown can point at the
  // specific one(s) rather than just the aggregate avatar dot.
  const unreadWsIds = React.useMemo(() => unreadWorkspaceIds(unreadSummary), [unreadSummary]);

  const queryClient = useQueryClient();
  const acceptInvitationMut = useMutation({
    mutationFn: (id: string) => api.acceptInvitation(id),
    // After accepting an invitation, navigate INTO the newly-joined workspace.
    // Otherwise the user stays on their current workspace and just sees the
    // new one appear in the dropdown — silent and confusing (this is MUL-820).
    onSuccess: async (_, invitationId) => {
      const invitation = myInvitations.find((i) => i.id === invitationId);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
      // staleTime: 0 forces a real network fetch — we need the joined workspace
      // in the list before we can resolve its slug for navigation.
      const list = await queryClient.fetchQuery({
        ...workspaceListOptions(),
        staleTime: 0,
      });
      const joined = invitation
        ? list.find((w) => w.id === invitation.workspace_id)
        : null;
      if (joined) {
        push(paths.workspace(joined.slug).issues());
      }
    },
    onError: () => {
      // "invitation is not pending" means the invite was concluded from
      // another surface while this row was on screen. Refetch so the stale
      // row drops instead of sticking around until restart — a silent
      // failure here reads as "the button does nothing".
      queryClient.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
    },
  });
  const declineInvitationMut = useMutation({
    mutationFn: (id: string) => api.declineInvitation(id),
    // Either outcome must refresh the list: success drops the declined row,
    // and a failure ("invitation is not pending") means the invite was
    // concluded from another surface — refetch drops the stale row.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.myInvitations() });
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={workspace?.name ?? "Multica"}
            title={workspace?.name ?? "Multica"}
            className="relative flex size-9 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent"
          >
            <WorkspaceAvatar name={workspace?.name ?? "M"} avatarUrl={workspace?.avatar_url} size="md" />
            {/* Shared brand dot: a pending invitation OR another workspace
                with unread inbox items. The active workspace's own unread
                stays on the Inbox rail badge, so it is deliberately excluded
                here. */}
            {(myInvitations.length > 0 || otherWorkspaceUnread) && (
              <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-brand ring-2 ring-sidebar" />
            )}
          </button>
        }
      />
      <DropdownMenuContent
        className="w-auto min-w-56"
        align="start"
        side="right"
        sideOffset={8}
      >
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <ActorAvatar
            name={user?.name ?? ""}
            initials={(user?.name ?? "U").charAt(0).toUpperCase()}
            avatarUrl={resolvePublicFileUrl(user?.avatar_url)}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium leading-tight">
              {user?.name}
            </p>
            <p className="truncate text-caption text-muted-foreground leading-tight">
              {user?.email}
            </p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-caption text-muted-foreground">
            {t(($) => $.sidebar.workspaces_label)}
          </DropdownMenuLabel>
          {workspaces.map((ws) => (
            <DropdownMenuItem
              key={ws.id}
              render={
                <AppLink href={paths.workspace(ws.slug).issues()} />
              }
            >
              <WorkspaceAvatar name={ws.name} avatarUrl={ws.avatar_url} size="sm" />
              <span className="flex-1 truncate">{ws.name}</span>
              {/* Points at the specific workspace holding unread inbox items.
                  Sits in the same right-edge slot as the active-workspace
                  check; the active workspace is excluded (its unread is the
                  Inbox rail badge), so dot and check never collide. */}
              {ws.id !== workspace?.id && unreadWsIds.has(ws.id) && (
                <span className="size-2 rounded-full bg-brand" />
              )}
              {ws.id === workspace?.id && (
                <Check className="h-3.5 w-3.5 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
          {!workspaceCreationDisabled && (
            <DropdownMenuItem
              onClick={() => push(paths.newWorkspace())}
            >
              <Plus className="h-3.5 w-3.5" />
              {t(($) => $.sidebar.create_workspace)}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {myInvitations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-caption text-muted-foreground">
                {t(($) => $.sidebar.pending_invitations_label)}
              </DropdownMenuLabel>
              {myInvitations.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 px-2 py-1.5">
                  <WorkspaceAvatar name={inv.workspace_name ?? "W"} size="sm" />
                  <span className="flex-1 truncate text-body">{inv.workspace_name ?? t(($) => $.sidebar.invitation_workspace_fallback)}</span>
                  <button
                    type="button"
                    className="text-caption px-2 py-0.5 rounded-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    disabled={acceptInvitationMut.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      acceptInvitationMut.mutate(inv.id);
                    }}
                  >
                    {t(($) => $.sidebar.invitation_join)}
                  </button>
                  <button
                    type="button"
                    className="text-caption px-2 py-0.5 rounded-xs bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
                    disabled={declineInvitationMut.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      declineInvitationMut.mutate(inv.id);
                    }}
                  >
                    {t(($) => $.sidebar.invitation_decline)}
                  </button>
                </div>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={logout}>
            <LogOut className="h-3.5 w-3.5" />
            {t(($) => $.sidebar.log_out)}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function hrefPathname(href: string): string {
  const query = href.indexOf("?");
  return query === -1 ? href : href.slice(0, query);
}

interface AppSidebarProps {
  /** Rendered above the rail and panel (e.g. desktop traffic light spacer) */
  topSlot?: React.ReactNode;
}

/**
 * Icon rail + context panel. The rail switches between modules (Inbox, Chat,
 * Issues, Projects, AI team); the panel beside it shows that module's
 * navigation, or — for Inbox and Chat — the page's own list, portaled in so
 * the main area holds only the detail. Collapsing the sidebar folds it down
 * to the rail.
 */
export function AppSidebar({ topSlot }: AppSidebarProps = {}) {
  const { t } = useT("layout");
  const navigation = useNavigation();
  const { pathname } = navigation;
  const search = navigation.searchParams.toString();
  const workspace = useCurrentWorkspace();
  const p = useWorkspacePaths();
  const wsId = workspace?.id ?? "";
  const { open, setOpen, isCompact, setOpenMobile } = useSidebar();

  // On a phone the sidebar is a Sheet covering the page, so navigating out of
  // it has to dismiss it — otherwise the destination renders underneath and the
  // tap reads as "nothing happened". Closing on `pathname` rather than on each
  // link's onClick covers every route out of here at once: the rail, the
  // panels, the workspace switcher's programmatic push, and anything added
  // later. `setOpenMobile` is a no-op on desktop, where the sheet is not the
  // sidebar's rendering at all.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  // The active module follows the route, but a route several modules lead to
  // (an issue detail) keeps the one it was opened from — so it is derived
  // from the previous module, adjusted during render to avoid a frame where
  // the panel shows the wrong module. A rail click names its module up front
  // (`pending`), since the route it reopens may be one of those shared ones.
  const [moduleState, setModuleState] = useState<{
    pathname: string;
    module: SidebarModule;
    pending: { pathname: string; module: SidebarModule } | null;
  }>(() => ({
    pathname,
    module: resolveSidebarModule(pathname, p, "issues"),
    pending: null,
  }));
  let activeModule = moduleState.module;
  if (moduleState.pathname !== pathname) {
    activeModule =
      moduleState.pending?.pathname === pathname
        ? moduleState.pending.module
        : resolveSidebarModule(pathname, p, moduleState.module);
    setModuleState({ pathname, module: activeModule, pending: null });
  }

  // Each module reopens where the user left it. Scoped to the workspace: a
  // remembered route belongs to the workspace it was visited in.
  const [lastHref, setLastHref] = useState<{
    wsId: string;
    byModule: Partial<Record<SidebarModule, string>>;
  }>({ wsId, byModule: {} });
  const currentHref = search ? `${pathname}?${search}` : pathname;
  const rememberRoute = ownsSidebarRoute(pathname, p);
  useEffect(() => {
    if (!rememberRoute) return;
    setLastHref((prev) =>
      prev.wsId === wsId && prev.byModule[activeModule] === currentHref
        ? prev
        : {
            wsId,
            byModule: {
              ...(prev.wsId === wsId ? prev.byModule : {}),
              [activeModule]: currentHref,
            },
          },
    );
  }, [activeModule, currentHref, rememberRoute, wsId]);
  const moduleHref = (module: SidebarModule) =>
    (lastHref.wsId === wsId ? lastHref.byModule[module] : undefined) ??
    sidebarModuleHome(module, p);

  // Nav badge. Reads the cross-workspace unread summary the switcher also
  // uses, so the count costs no request of its own (MUL-6967).
  const inboxUnreadCount = useInboxUnreadCount(workspace?.id);
  // Chat unread badge: IM-style total of unread *messages* across chat
  // threads (countUnreadChatMessages is the shared definition — mobile's tab
  // badge derives from the same function, keeping the platforms in agreement).
  const { data: chatSessions = [] } = useQuery({
    ...chatSessionsOptions(wsId),
    enabled: !!wsId,
  });
  // The session the user is reading right now must not count: the thread list
  // renders its row badge as 0 (auto mark-read is about to clear it), and a
  // reply landing in the open conversation would otherwise flash a sidebar
  // count with no matching row. "Reading right now" = a session is active, a
  // chat surface is actually showing it (chat page route or the floating
  // window), AND the app is in the foreground. When the app is backgrounded,
  // auto mark-read is suppressed (MUL-4485) so the reply stays unread — the
  // badge must count it, or the notification is silently eaten while the user
  // is away. A remembered selection while both surfaces are closed also still
  // counts, for the same reason.
  const activeChatSessionId = useChatStore((s) => s.activeSessionId);
  const floatingChatOpen = useChatStore((s) => s.isOpen);
  const appForeground = useAppForeground();
  const viewedChatSessionId =
    appForeground && (floatingChatOpen || isNavActive(pathname, p.chat()))
      ? activeChatSessionId
      : null;
  const chatUnreadCount = React.useMemo(
    () => countUnreadChatMessages(chatSessions, viewedChatSessionId),
    [chatSessions, viewedChatSessionId],
  );
  const runningAgentCount = useRunningAgentCount(workspace?.id);
  const searchShortcut = useShortcut("openSearch");
  const createIssueShortcut = useShortcut("createIssue");

  const moduleLabel = (module: SidebarModule) => {
    switch (module) {
      case "inbox":
        return t(($) => $.nav.inbox);
      case "chat":
        return t(($) => $.nav.chat);
      case "issues":
        return t(($) => $.nav.issues);
      case "projects":
        return t(($) => $.nav.projects);
      case "team":
        return t(($) => $.sidebar.ai_team_group);
    }
  };

  const onRailModuleClick = (module: SidebarModule, href: string) => (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (!isCompact && module === activeModule && open) {
      // The active module's icon folds the panel away instead of reloading
      // the route it is already on.
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!isCompact && !open) setOpen(true);
    const target = hrefPathname(href);
    setModuleState((state) =>
      target === state.pathname
        ? { ...state, module, pending: null }
        : { ...state, pending: { pathname: target, module } },
    );
  };

  const settingsHref = p.settings();
  const isListModule = LIST_MODULES.has(activeModule);
  // The list slot exists only while the panel is an on-screen column; the
  // page falls back to its own two-pane layout otherwise.
  const showListSlot = isListModule && open && !isCompact;
  // In the compact sheet the Inbox and Chat pages show their list themselves,
  // so the panel offers the general task navigation instead.
  const panelModule: SidebarModule = isListModule && isCompact ? "issues" : activeModule;

  return (
    <Sidebar variant="inset" collapsible="icon">
      {topSlot}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t(($) => $.sidebar.modules_label)}
          data-slot="sidebar-module-rail"
          className="flex w-12 shrink-0 flex-col items-center gap-1 pt-2 pb-2"
        >
          <WorkspaceMenu />
          <RailTooltip
            label={
              <span className="flex items-center gap-2">
                {t(($) => $.sidebar.search)}
                {searchShortcut ? <ShortcutKeycaps shortcut={searchShortcut} decorative /> : null}
              </span>
            }
          >
            <button
              type="button"
              aria-label={t(($) => $.sidebar.search)}
              className={RAIL_ITEM_CLASS_NAME}
              onClick={() => useSearchStore.getState().setOpen(true)}
            >
              <Search />
            </button>
          </RailTooltip>
          <div className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />
          {SIDEBAR_MODULES.map((module) => {
            const href = moduleHref(module);
            const Icon = routeIconForPath(
              module === "issues" ? p.issues() : sidebarModuleHome(module, p),
            );
            const label = moduleLabel(module);
            const isActive = module === activeModule && !isNavActive(pathname, settingsHref);
            return (
              <React.Fragment key={module}>
                {module === "issues" && <div className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />}
                <RailTooltip label={label}>
                  <AppLink
                    href={href}
                    aria-label={label}
                    aria-current={isActive ? "page" : undefined}
                    data-active={isActive ? "" : undefined}
                    data-module={module}
                    className={RAIL_ITEM_CLASS_NAME}
                    onClick={onRailModuleClick(module, href)}
                  >
                    <Icon />
                    {module === "inbox" && (
                      <RailBadge value={inboxUnreadCount} label={String(inboxUnreadCount)} />
                    )}
                    {module === "chat" && (
                      <RailBadge value={chatUnreadCount} label={String(chatUnreadCount)} />
                    )}
                    {module === "team" && runningAgentCount > 0 && (
                      <span
                        data-slot="rail-running-dot"
                        aria-label={t(($) => $.sidebar.running_badge, { count: runningAgentCount })}
                        className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-success ring-2 ring-sidebar"
                      />
                    )}
                  </AppLink>
                </RailTooltip>
              </React.Fragment>
            );
          })}
          <div className="flex-1" />
          <RailTooltip
            label={
              <span className="flex items-center gap-2">
                {t(($) => $.sidebar.new_issue)}
                {createIssueShortcut ? <ShortcutKeycaps shortcut={createIssueShortcut} decorative /> : null}
              </span>
            }
          >
            <button
              type="button"
              aria-label={t(($) => $.sidebar.new_issue)}
              className={RAIL_ITEM_CLASS_NAME}
              onClick={() => openCreateIssueWithPreference()}
            >
              <SquarePen />
              <DraftDot />
            </button>
          </RailTooltip>
          <HelpLauncher />
          <RailTooltip label={t(($) => $.nav.settings)}>
            <AppLink
              href={settingsHref}
              aria-label={t(($) => $.nav.settings)}
              data-active={isNavActive(pathname, settingsHref) ? "" : undefined}
              className={RAIL_ITEM_CLASS_NAME}
            >
              {React.createElement(routeIconForPath(settingsHref))}
            </AppLink>
          </RailTooltip>
        </nav>

        <div
          data-slot="sidebar-module-panel"
          data-module={panelModule}
          className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden"
        >
          {showListSlot ? (
            <SidebarListSlot />
          ) : (
            <>
              {panelModule === "issues" && <IssuesPanel wsId={wsId} pathname={pathname} />}
              {panelModule === "projects" && <ProjectsPanel wsId={wsId} pathname={pathname} />}
              {panelModule === "team" && <TeamPanel wsId={wsId} pathname={pathname} />}
              <SidebarFooter className="p-2">
                <JoinDiscordCard />
              </SidebarFooter>
            </>
          )}
        </div>
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
