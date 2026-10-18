import { describe, expect, it } from "vitest";
import { paths } from "@multica/core/paths";
import { ownsSidebarRoute, resolveSidebarModule, sidebarModuleHome } from "./sidebar-modules";

const p = paths.workspace("acme");

describe("resolveSidebarModule", () => {
  it("maps each module's own routes to it", () => {
    expect(resolveSidebarModule("/acme/inbox", p, "issues")).toBe("inbox");
    expect(resolveSidebarModule("/acme/chat", p, "issues")).toBe("chat");
    expect(resolveSidebarModule("/acme/my-issues", p, "team")).toBe("issues");
    expect(resolveSidebarModule("/acme/issues", p, "team")).toBe("issues");
    expect(resolveSidebarModule("/acme/projects/p-1", p, "issues")).toBe("projects");
    for (const route of ["agents/a-1", "squads", "autopilots/x", "skills", "runtimes", "usage"]) {
      expect(resolveSidebarModule(`/acme/${route}`, p, "issues")).toBe("team");
    }
  });

  it("keeps the panel an issue detail was opened from", () => {
    expect(resolveSidebarModule("/acme/issues/i-1", p, "projects")).toBe("projects");
    expect(resolveSidebarModule("/acme/issues/i-1", p, "team")).toBe("team");
  });

  it("sends an issue detail opened from Inbox or Chat to Issues", () => {
    expect(resolveSidebarModule("/acme/issues/i-1", p, "inbox")).toBe("issues");
    expect(resolveSidebarModule("/acme/issues/i-1", p, "chat")).toBe("issues");
  });

  it("leaves the panel alone on routes no module owns", () => {
    expect(resolveSidebarModule("/acme/settings", p, "projects")).toBe("projects");
    expect(ownsSidebarRoute("/acme/settings", p)).toBe(false);
    expect(ownsSidebarRoute("/acme/issues/i-1", p)).toBe(true);
  });

  it("opens each module at its landing route", () => {
    expect(sidebarModuleHome("issues", p)).toBe("/acme/my-issues");
    expect(sidebarModuleHome("team", p)).toBe("/acme/agents");
  });
});
