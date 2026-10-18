import type { WorkspacePaths } from "@multica/core/paths";

/**
 * A rail entry; its panel fills the first column of the canvas.
 *
 * The rail splits the product by what the user is doing rather than by page:
 * handling what needs them (mine), talking to agents (chat), moving work
 * forward (work), looking after the people and agents doing it (team), and
 * configuring the workspace (settings).
 */
export type SidebarModule = "mine" | "chat" | "work" | "team" | "settings";

/** The modules listed in the rail's main group; settings sits at its foot. */
export const SIDEBAR_MODULES: readonly SidebarModule[] = ["mine", "chat", "work", "team"];

/** Top-level nav stays lit on child routes (Projects on /:slug/projects/:id). */
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
  | "autopilots"
  | "agents"
  | "squads"
  | "skills"
  | "runtimes"
  | "usage"
  | "settings"
> & { memberDetail: (id: string) => string };

/** Where a rail entry lands the first time it is opened. */
export function sidebarModuleHome(module: SidebarModule, p: ModulePaths): string {
  switch (module) {
    case "mine":
      return p.myIssues();
    case "chat":
      return p.chat();
    case "work":
      return p.issues();
    case "team":
      return p.agents();
    case "settings":
      return p.settings();
  }
}

// Members have detail pages but no list route; the prefix is their parent.
const membersPrefix = (p: ModulePaths) => p.memberDetail("").replace(/\/$/, "");

function routeModule(pathname: string, p: ModulePaths): SidebarModule | null {
  if (isNavActive(pathname, p.inbox()) || isNavActive(pathname, p.myIssues())) return "mine";
  if (isNavActive(pathname, p.chat())) return "chat";
  if (
    pathname === p.issues() ||
    isNavActive(pathname, p.projects()) ||
    isNavActive(pathname, p.autopilots())
  ) {
    return "work";
  }
  if (
    isNavActive(pathname, p.agents()) ||
    isNavActive(pathname, p.squads()) ||
    isNavActive(pathname, membersPrefix(p))
  ) {
    return "team";
  }
  if (
    isNavActive(pathname, p.settings()) ||
    isNavActive(pathname, p.skills()) ||
    isNavActive(pathname, p.runtimes()) ||
    isNavActive(pathname, p.usage())
  ) {
    return "settings";
  }
  return null;
}

/**
 * Whether a route is somewhere a module's panel leads, so a rail entry may
 * reopen it later. Issue details are reached from every panel and are
 * remembered too; unowned routes (attachment previews) are not.
 */
export function ownsSidebarRoute(pathname: string, p: ModulePaths): boolean {
  return routeModule(pathname, p) !== null || isNavActive(pathname, p.issues());
}

/**
 * The module a route belongs to, given the module already showing.
 *
 * An issue detail is reached from Mine's queue, a project in Work, or an
 * agent in Team, so it keeps the panel it was opened from. Chat and Settings
 * have no issue rows of their own; an issue opened from there belongs to
 * Work. Routes no module owns keep the current panel.
 */
export function resolveSidebarModule(
  pathname: string,
  p: ModulePaths,
  current: SidebarModule,
): SidebarModule {
  const owner = routeModule(pathname, p);
  if (owner) return owner;
  if (isNavActive(pathname, p.issues())) {
    return current === "chat" || current === "settings" ? "work" : current;
  }
  return current;
}
