// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useIssuesScopeStore } from "./issues-scope-store";
import { setCurrentWorkspace } from "../../platform/workspace-storage";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// Node's partial localStorage can shadow jsdom's Storage implementation.
beforeAll(() => {
  if (typeof globalThis.localStorage?.clear !== "function") {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, value); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }
});

describe("issues scope store", () => {
  beforeEach(async () => {
    setCurrentWorkspace(null, null);
    await flush();
    localStorage.clear();
    useIssuesScopeStore.setState({ scopes: {} });
  });

  afterEach(async () => {
    setCurrentWorkspace(null, null);
    await flush();
  });

  it("keeps each page's tab independent", () => {
    const { setScope } = useIssuesScopeStore.getState();
    setScope("project:p1", "agents");
    setScope("issues", "members");

    const { scopes } = useIssuesScopeStore.getState();
    expect(scopes["project:p1"]).toBe("agents");
    expect(scopes["issues"]).toBe("members");
    expect(scopes["project:p2"]).toBeUndefined();
  });

  it("migrates the v0 global tab onto the Issues page only", () => {
    const migrate = useIssuesScopeStore.persist.getOptions().migrate!;
    expect(migrate({ scope: "agents" }, 0)).toEqual({
      scopes: { issues: "agents" },
    });
    // v0 "all" (or garbage) starts every page fresh.
    expect(migrate({ scope: "all" }, 0)).toEqual({ scopes: {} });
    expect(migrate({ bogus: true }, 0)).toEqual({ scopes: {} });
    expect(migrate(undefined, 0)).toEqual({ scopes: {} });
  });

  it.each(["agents", "members"] as const)(
    "resets a fresh workspace after leaving the %s tab and preserves each workspace's preferences",
    async (scope) => {
      setCurrentWorkspace("acme", "ws_a");
      await flush();
      useIssuesScopeStore.getState().setScope("issues", scope);
      useIssuesScopeStore.getState().setScope("project:p1", "members");
      const savedAcme = localStorage.getItem("multica_issues_scope:acme");

      setCurrentWorkspace("beta", "ws_b");
      await flush();

      expect(useIssuesScopeStore.getState().scopes).toEqual({});
      expect(localStorage.getItem("multica_issues_scope:beta")).toBeNull();
      expect(localStorage.getItem("multica_issues_scope:acme")).toBe(savedAcme);

      useIssuesScopeStore.getState().setScope("project:p2", "agents");
      expect(JSON.parse(localStorage.getItem("multica_issues_scope:beta") ?? "null")).toEqual({
        state: { scopes: { "project:p2": "agents" } },
        version: 1,
      });

      setCurrentWorkspace("acme", "ws_a");
      await flush();
      expect(useIssuesScopeStore.getState().scopes).toEqual({
        issues: scope,
        "project:p1": "members",
      });
      expect(localStorage.getItem("multica_issues_scope:acme")).toBe(savedAcme);

      setCurrentWorkspace("beta", "ws_b");
      await flush();
      expect(useIssuesScopeStore.getState().scopes).toEqual({ "project:p2": "agents" });
    },
  );

  it("restores a destination workspace's saved scopes without carrying over other pages", async () => {
    localStorage.setItem(
      "multica_issues_scope:beta",
      JSON.stringify({ state: { scopes: { issues: "members" } }, version: 1 }),
    );
    setCurrentWorkspace("acme", "ws_a");
    await flush();
    useIssuesScopeStore.getState().setScope("issues", "agents");
    useIssuesScopeStore.getState().setScope("project:p1", "members");

    setCurrentWorkspace("beta", "ws_b");
    await flush();
    expect(useIssuesScopeStore.getState().scopes).toEqual({ issues: "members" });

    setCurrentWorkspace("acme", "ws_a");
    await flush();
    expect(useIssuesScopeStore.getState().scopes).toEqual({
      issues: "agents",
      "project:p1": "members",
    });
  });

  it.each(["all", "agents", "members"] as const)(
    "migrates a destination workspace's v0 %s tab without inheriting project scopes",
    async (scope) => {
      localStorage.setItem(
        "multica_issues_scope:beta",
        JSON.stringify({ state: { scope }, version: 0 }),
      );
      setCurrentWorkspace("acme", "ws_a");
      await flush();
      useIssuesScopeStore.getState().setScope("issues", "agents");
      useIssuesScopeStore.getState().setScope("project:p1", "members");
      const savedAcme = localStorage.getItem("multica_issues_scope:acme");

      setCurrentWorkspace("beta", "ws_b");
      await flush();
      const scopes = scope === "all" ? {} : { issues: scope };
      expect(useIssuesScopeStore.getState().scopes).toEqual(scopes);
      expect(JSON.parse(localStorage.getItem("multica_issues_scope:beta") ?? "null")).toEqual({
        state: { scopes },
        version: 1,
      });
      expect(localStorage.getItem("multica_issues_scope:acme")).toBe(savedAcme);
    },
  );
});
