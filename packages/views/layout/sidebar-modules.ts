import type { WorkspacePaths } from "@multica/core/paths";

/** A rail entry; its panel fills the column beside the rail. */
export type SidebarModule = "inbox" | "chat" | "issues" | "projects" | "team";

export const SIDEBAR_MODULES: readonly SidebarModule[] = [
  "inbox",
  "chat",
  "issues",
  "projects",
  "team",
];

/** Modules whose panel is the page's own list, portaled in by the page. */
export const LIST_MODULES: ReadonlySet<SidebarModule> = new Set(["inbox", "chat"]);

// Top-level nav stays lit on child routes (Projects on /:slug/projects/:id).
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

type ModulePaths = Pick<
  WorkspacePaths,
  | "inbox"
  | "chat"
  | "myIssues"
  | "issues"
  | "projects"
  | "agents"
  | "squads"
  | "autopilots"
  | "skills"
  | "runtimes"
  | "usage"
>;

/** Where a rail entry lands the first time it is opened. */
export function sidebarModuleHome(module: SidebarModule, p: ModulePaths): string {
  switch (module) {
    case "inbox":
      return p.inbox();
    case "chat":
      return p.chat();
    case "issues":
      return p.myIssues();
    case "projects":
      return p.projects();
    case "team":
      return p.agents();
  }
}

const TEAM_ROUTES = ["agents", "squads", "autopilots", "skills", "runtimes", "usage"] as const;

/**
 * Whether a route is somewhere a module's panel leads, so a rail entry may
 * reopen it later. Settings and other unowned routes are not remembered.
 */
export function ownsSidebarRoute(pathname: string, p: ModulePaths): boolean {
  return [
    p.inbox(),
    p.chat(),
    p.myIssues(),
    p.issues(),
    p.projects(),
    ...TEAM_ROUTES.map((key) => p[key]()),
  ].some((href) => isNavActive(pathname, href));
}

/**
 * The module a route belongs to, given the module already showing.
 *
 * An issue detail is reached from every panel — a project's issue, a running
 * agent's task, a pin — so it keeps the panel it was opened from rather than
 * yanking the user to Issues. Inbox and Chat are the exception: their panel
 * is a list for their own page, which an issue page does not have. Routes no
 * module owns (settings, member pages) keep the current panel as well.
 */
export function resolveSidebarModule(
  pathname: string,
  p: ModulePaths,
  current: SidebarModule,
): SidebarModule {
  if (isNavActive(pathname, p.inbox())) return "inbox";
  if (isNavActive(pathname, p.chat())) return "chat";
  if (pathname === p.issues() || isNavActive(pathname, p.myIssues())) return "issues";
  if (isNavActive(pathname, p.issues())) {
    return LIST_MODULES.has(current) ? "issues" : current;
  }
  if (isNavActive(pathname, p.projects())) return "projects";
  if (TEAM_ROUTES.some((key) => isNavActive(pathname, p[key]()))) return "team";
  return current;
}
