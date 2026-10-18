"use client";

import React, { createContext, use, useMemo, useState } from "react";
import {
  AlarmClock,
  BarChart3,
  Bell,
  Blocks,
  BookOpenText,
  CircleDot,
  CreditCard,
  FolderGit2,
  Keyboard,
  KeyRound,
  Laptop,
  ListPlus,
  Lock,
  MessagesSquare,
  Monitor,
  Plug,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Tags,
  User,
  Users,
  X,
  Workflow,
  Zap,
} from "lucide-react";
import { useAuthStore } from "@multica/core/auth";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useFeatureEnabled } from "@multica/core/config";
import { useCurrentMember } from "@multica/core/permissions";
import {
  BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG,
  PLUGINS_V1_FLAG,
  PROJECT_WORKFLOWS_V1_FLAG,
} from "@multica/core/feature-flags";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";
import { cn } from "@multica/ui/lib/utils";
import { resolveSettingsLocation, settingsHref } from "./settings-navigation";
import { AppLink, useNavigation } from "../../navigation";
import { WorkspaceAvatar } from "../../workspace/workspace-avatar";
import { AccountTab } from "./account-tab";
import { PreferencesTab } from "./preferences-tab";
import { TokensTab } from "./tokens-tab";
import { WorkspaceTab } from "./workspace-tab";
import { MembersTab } from "./members-tab";
import { CodeTab } from "./code-tab";
import { ChannelsTab } from "./channels-tab";
import { ConnectedAppsTab, useComposioAvailable } from "./connected-apps-tab";
import { NotificationsTab } from "./notifications-tab";
import { LabelsTab } from "./labels-tab";
import { IssueStatusesTab } from "./issue-statuses-tab";
import { WorkflowsTab } from "../../workflows/workflows-tab";
import { PropertiesTab } from "./properties-tab";
import { QuickActionsTab } from "./quick-actions-tab";
import { KeyboardShortcutsTab } from "./keyboard-shortcuts-tab";
import { PluginsTab } from "./plugins-tab";
import { McpTab } from "./mcp-tab";
import { BillingTab } from "./billing-tab";
import { searchSettings } from "./settings-search";
import { HighlightText } from "../../search/highlight-text";
import { useSettingsSearchIndex } from "./use-settings-search-index";
import { WakeupsTab } from "./wakeups-tab";
import { SidebarPanelHeader } from "../../layout/sidebar-list-slot";
import { isNavActive } from "../../layout/sidebar-modules";
import { useT } from "../../i18n";

export interface ExtraSettingsTab {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  content: React.ReactNode;
}

export interface SettingsEntry {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** A tab's page. Absent on entries that lead to their own route. */
  content?: React.ReactNode;
  /** A route outside the settings page (Skills, Runtimes, Analytics). */
  href?: string;
  wide?: boolean;
  /** Owners and admins manage it; members see a read-only page. */
  adminOnly?: boolean;
}

interface SettingsSubgroup {
  key: string;
  label?: string;
  entries: SettingsEntry[];
}

export interface SettingsScopeGroup {
  key: "personal" | "workspace" | "device";
  label: string;
  /** Leading mark: whose settings these are. */
  mark: React.ReactNode;
  /** Trailing detail (the user's name, "Workspace"). */
  tag?: string;
  subgroups: SettingsSubgroup[];
}

const SettingsExtraTabsContext = createContext<ExtraSettingsTab[]>([]);

/** Device settings supplied by a platform shell (the desktop app). */
export function SettingsExtraTabsProvider({
  tabs,
  children,
}: {
  tabs: ExtraSettingsTab[];
  children: React.ReactNode;
}) {
  return <SettingsExtraTabsContext value={tabs}>{children}</SettingsExtraTabsContext>;
}

/**
 * Every settings entry, grouped by whose settings they are, and the tab the
 * current URL selects. Shared by the settings page and the Settings panel.
 */
export function useSettingsGroups() {
  const { t } = useT("settings");
  const { t: tl } = useT("layout");
  const p = useWorkspacePaths();
  const workspace = useCurrentWorkspace();
  const workspaceName = workspace?.name ?? t(($) => $.page.workspace_fallback);
  const user = useAuthStore((s) => s.user);
  const { role } = useCurrentMember(workspace?.id ?? "");
  const navigation = useNavigation();
  const extraDeviceTabs = use(SettingsExtraTabsContext);
  const pluginsEnabled = useFeatureEnabled(PLUGINS_V1_FLAG, false);
  const workflowsEnabled = useFeatureEnabled(PROJECT_WORKFLOWS_V1_FLAG, false);
  const billingEnabled = useFeatureEnabled(BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG, false);
  const appsAvailable = useComposioAvailable();
  const entry = (
    value: string,
    label: string,
    icon: SettingsEntry["icon"],
    content: React.ReactNode,
    options: { wide?: boolean; adminOnly?: boolean } = {},
  ): SettingsEntry => ({ value, label, icon, content, ...options });
  const link = (value: string, label: string, icon: SettingsEntry["icon"], href: string): SettingsEntry => ({
    value,
    label,
    icon,
    href,
  });

  const groups: SettingsScopeGroup[] = [
    {
      key: "personal",
      label: t(($) => $.page.groups.personal),
      mark: (
        <ActorAvatar
          name={user?.name ?? ""}
          initials={(user?.name ?? "U").charAt(0).toUpperCase()}
          avatarUrl={resolvePublicFileUrl(user?.avatar_url)}
          size="xs"
        />
      ),
      tag: user?.name,
      subgroups: [
        {
          key: "personal",
          entries: [
            entry("profile", t(($) => $.page.tabs.profile), User, <AccountTab />),
            entry("preferences", t(($) => $.page.tabs.preferences), SlidersHorizontal, <PreferencesTab />),
            entry("notifications", t(($) => $.page.tabs.notifications), Bell, <NotificationsTab />),
            entry("shortcuts", t(($) => $.page.tabs.shortcuts), Keyboard, <KeyboardShortcutsTab />),
            ...(appsAvailable
              ? [entry("apps", t(($) => $.page.tabs.apps), Plug, <ConnectedAppsTab />)]
              : []),
            entry("tokens", t(($) => $.page.tabs.tokens), KeyRound, <TokensTab />),
          ],
        },
      ],
    },
    {
      key: "workspace",
      label: workspaceName,
      mark: (
        <WorkspaceAvatar
          name={workspaceName}
          avatarUrl={workspace?.avatar_url}
          size="sm"
          className="size-4 rounded-xs"
        />
      ),
      tag: t(($) => $.page.groups.workspace),
      subgroups: [
        {
          key: "workspace",
          entries: [
            entry("workspace", t(($) => $.page.tabs.general), Settings, <WorkspaceTab />, {
              adminOnly: true,
            }),
            entry("members", t(($) => $.page.tabs.members), Users, <MembersTab />, {
              adminOnly: true,
            }),
            ...(billingEnabled
              ? [entry("billing", t(($) => $.page.tabs.billing), CreditCard, <BillingTab />)]
              : []),
          ],
        },
        {
          key: "capabilities",
          label: t(($) => $.page.groups.capabilities),
          entries: [
            link("skills", tl(($) => $.nav.skills), BookOpenText, p.skills()),
            link("runtimes", tl(($) => $.nav.runtimes), Monitor, p.runtimes()),
            link("usage", tl(($) => $.nav.usage), BarChart3, p.usage()),
          ],
        },
        {
          key: "issues",
          label: t(($) => $.page.groups.issues),
          entries: [
            ...(workflowsEnabled
              ? [entry("workflows", t(($) => $.page.tabs.workflows), Workflow, <WorkflowsTab />, {
                  wide: true,
                  adminOnly: true,
                })]
              : [entry("issue-statuses", t(($) => $.page.tabs.issue_statuses), CircleDot, <IssueStatusesTab />, {
                  wide: true,
                  adminOnly: true,
                })]),
            entry("wakeups", t(($) => $.page.tabs.wakeups), AlarmClock, <WakeupsTab />, {
              wide: true,
              adminOnly: true,
            }),
            entry("labels", t(($) => $.page.tabs.labels), Tags, <LabelsTab />, {
              wide: true,
            }),
            entry("properties", t(($) => $.page.tabs.properties), ListPlus, <PropertiesTab />, {
              wide: true,
              adminOnly: true,
            }),
            entry("quick-actions", t(($) => $.page.tabs.quick_actions), Zap, <QuickActionsTab />, {
              wide: true,
            }),
          ],
        },
        {
          key: "connections",
          label: t(($) => $.page.groups.connections),
          entries: [
            entry("code", t(($) => $.page.tabs.code), FolderGit2, <CodeTab />, {
              adminOnly: true,
            }),
            entry("channels", t(($) => $.page.tabs.channels), MessagesSquare, <ChannelsTab />),
            entry("mcp", t(($) => $.page.tabs.mcp), Server, <McpTab />, {
              adminOnly: true,
            }),
            ...(pluginsEnabled
              ? [entry("plugins", t(($) => $.page.tabs.plugins), Blocks, <PluginsTab />, {
                  adminOnly: true,
                })]
              : []),
          ],
        },
      ],
    },
    ...(extraDeviceTabs.length
      ? [
          {
            key: "device" as const,
            label: t(($) => $.page.groups.device),
            mark: <Laptop aria-hidden="true" className="size-4 text-muted-foreground" />,
            subgroups: [{ key: "device", entries: extraDeviceTabs }],
          },
        ]
      : []),
  ];
  const tabEntries = groups.flatMap((group) =>
    group.subgroups.flatMap((subgroup) => subgroup.entries.filter((item) => !item.href)),
  );
  const onSettings = isNavActive(navigation.pathname, p.settings());
  const location = resolveSettingsLocation(onSettings ? navigation.searchParams : new URLSearchParams());
  const candidate = location.tab === "billing" && !billingEnabled ? "workspace" : location.tab;
  const active = tabEntries.find((item) => item.value === candidate) ?? tabEntries[0]!;
  const tabHref = (value: string, options?: Parameters<typeof settingsHref>[3]) =>
    settingsHref(
      p.settings(),
      onSettings ? navigation.searchParams : new URLSearchParams(),
      value,
      options,
    );

  return {
    groups,
    tabEntries,
    active,
    location,
    onSettings,
    tabHref,
    isMember: role === "member",
  };
}

/** Search box and grouped entries: the settings page's navigation. */
export function SettingsNav({ className }: { className?: string }) {
  const { t } = useT("settings");
  const navigation = useNavigation();
  const { groups, tabEntries, active, onSettings, tabHref, isMember } = useSettingsGroups();

  const scopeOf = (value: string) =>
    groups.find((group) =>
      group.subgroups.some((subgroup) => subgroup.entries.some((item) => item.value === value)),
    );

  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const searchPages = useMemo(
    () => tabEntries.map((item) => ({ value: item.value, label: item.label })),
    // Labels are derived from i18n and flags; the value list is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabEntries.map((item) => `${item.value}:${item.label}`).join("|")],
  );
  const index = useSettingsSearchIndex(searchPages);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const openResult = (position: number) => {
    const result = results[position];
    if (!result) return;
    setActiveResult(position);
    navigation.push(tabHref(result.tab, { section: result.anchor, integration: result.integration }));
  };

  const navItem = (item: SettingsEntry) => {
    const href = item.href ?? tabHref(item.value);
    const isActive = item.href
      ? isNavActive(navigation.pathname, item.href)
      : onSettings && active.value === item.value;
    return (
      <li key={item.value}>
        <AppLink
          href={href}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex min-h-8 items-center gap-2.5 rounded-lg px-3 py-1.5 text-body transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            isActive
              ? "bg-surface-selected font-medium text-surface-selected-foreground hover:bg-surface-selected"
              : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
          )}
        >
          <item.icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {isMember && item.adminOnly ? (
            <Lock className="size-3 shrink-0 text-faint-foreground" aria-label={t(($) => $.page.admin_only)} />
          ) : null}
        </AppLink>
      </li>
    );
  };

  const searchResults = (
    <div className="space-y-1">
      <p className="px-3 pb-1 text-caption text-muted-foreground" role="status">
        {results.length > 0
          ? t(($) => $.page.search_results, { count: results.length })
          : t(($) => $.page.search_empty)}
      </p>
      <ul id="settings-search-results" role="listbox" aria-label={t(($) => $.page.search)}>
        {results.map((result, position) => {
          const page = tabEntries.find((item) => item.value === result.tab);
          const scope = scopeOf(result.tab);
          const path = [scope?.label, result.anchor || result.integration ? page?.label : null]
            .filter(Boolean)
            .join(" › ");
          return (
            <li key={`${result.tab}#${result.anchor ?? ""}#${result.integration ?? ""}`}>
              <button
                type="button"
                role="option"
                aria-selected={position === activeResult}
                onClick={() => openResult(position)}
                onMouseMove={() => setActiveResult(position)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  position === activeResult
                    ? "bg-surface-selected text-surface-selected-foreground"
                    : "hover:bg-surface-hover",
                )}
              >
                <span className="block truncate text-body">
                  <HighlightText text={result.title} query={query} />
                </span>
                {result.snippet ? (
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                    <HighlightText text={result.snippet} query={query} />
                  </span>
                ) : null}
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">{path}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="relative mx-3 mb-3 shrink-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveResult(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveResult((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveResult((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              openResult(activeResult);
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
          placeholder={t(($) => $.page.search)}
          aria-label={t(($) => $.page.search)}
          aria-controls={query ? "settings-search-results" : undefined}
          className="h-8 w-full rounded-lg border border-input bg-transparent pl-8 pr-8 text-body outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t(($) => $.page.search_clear)}
            className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <nav aria-label={t(($) => $.page.title)} className="min-h-0 overflow-y-auto px-3 pb-6">
        {query ? (
          searchResults
        ) : (
          <div className="divide-y divide-surface-border">
            {groups.map((group) => (
              <section
                key={group.key}
                aria-labelledby={`settings-group-${group.key}`}
                className="py-2.5 first:pt-0"
              >
                <h2
                  id={`settings-group-${group.key}`}
                  className="flex h-8 min-w-0 items-center gap-2.5 px-3 text-label font-semibold text-foreground"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">{group.mark}</span>
                  <span className="truncate">{group.label}</span>
                  {group.tag ? (
                    <span className="ml-auto shrink-0 truncate text-micro font-medium text-muted-foreground">
                      {group.tag}
                    </span>
                  ) : null}
                </h2>
                {group.subgroups.map((subgroup) => (
                  <div
                    key={subgroup.key}
                    role={subgroup.label ? "group" : undefined}
                    aria-labelledby={subgroup.label ? `settings-subgroup-${subgroup.key}` : undefined}
                  >
                    {subgroup.label ? (
                      <h3
                        id={`settings-subgroup-${subgroup.key}`}
                        className="px-3 pb-1 pt-3 text-caption font-medium text-muted-foreground"
                      >
                        {subgroup.label}
                      </h3>
                    ) : null}
                    <ul className="space-y-px">{subgroup.entries.map(navItem)}</ul>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}

/** The Settings module's panel: the settings navigation, on every route it owns. */
export function SettingsPanel() {
  const { t } = useT("settings");
  return (
    <>
      <SidebarPanelHeader title={t(($) => $.page.title)} />
      <SettingsNav className="flex-1 pt-3" />
    </>
  );
}
