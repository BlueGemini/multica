import { describe, expect, it } from "vitest";
import { paths } from "@multica/core/paths";
import { ownsSidebarRoute, resolveSidebarModule, sidebarModuleHome } from "./sidebar-modules";

const p = paths.workspace("acme");

describe("resolveSidebarModule", () => {
  it("maps each module's own routes to it", () => {
    expect(resolveSidebarModule("/acme/inbox", p, "work")).toBe("mine");
    expect(resolveSidebarModule("/acme/my-issues", p, "team")).toBe("mine");
    expect(resolveSidebarModule("/acme/chat", p, "work")).toBe("chat");
    for (const route of ["issues", "projects", "projects/p-1", "autopilots/x"]) {
      expect(resolveSidebarModule(`/acme/${route}`, p, "team")).toBe("work");
    }
    for (const route of ["agents/a-1", "squads", "members/u-1"]) {
      expect(resolveSidebarModule(`/acme/${route}`, p, "work")).toBe("team");
    }
    for (const route of ["settings", "skills/s-1", "runtimes", "usage"]) {
      expect(resolveSidebarModule(`/acme/${route}`, p, "work")).toBe("settings");
    }
  });

  it("keeps the panel an issue detail was opened from", () => {
    expect(resolveSidebarModule("/acme/issues/i-1", p, "mine")).toBe("mine");
    expect(resolveSidebarModule("/acme/issues/i-1", p, "work")).toBe("work");
    expect(resolveSidebarModule("/acme/issues/i-1", p, "team")).toBe("team");
  });

  it("sends an issue detail opened from Chat or Settings to Work", () => {
    expect(resolveSidebarModule("/acme/issues/i-1", p, "chat")).toBe("work");
    expect(resolveSidebarModule("/acme/issues/i-1", p, "settings")).toBe("work");
  });

  it("leaves the panel alone on routes no module owns", () => {
    expect(resolveSidebarModule("/acme/attachments/a-1/preview", p, "team")).toBe("team");
    expect(ownsSidebarRoute("/acme/attachments/a-1/preview", p)).toBe(false);
    expect(ownsSidebarRoute("/acme/issues/i-1", p)).toBe(true);
    expect(ownsSidebarRoute("/acme/settings", p)).toBe(true);
  });

  it("opens each module at its landing route", () => {
    expect(sidebarModuleHome("mine", p)).toBe("/acme/my-issues");
    expect(sidebarModuleHome("work", p)).toBe("/acme/issues");
    expect(sidebarModuleHome("team", p)).toBe("/acme/agents");
    expect(sidebarModuleHome("settings", p)).toBe("/acme/settings");
  });
});
