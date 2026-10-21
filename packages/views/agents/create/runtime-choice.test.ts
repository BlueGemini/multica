// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@multica/core/types";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";
import {
  buildRuntimeChoiceGroups,
  filterDevice,
  harnessOption,
  previewOptions,
} from "./runtime-choice";

const NOW = new Date("2026-10-18T12:00:00Z").getTime();

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-local",
    name: "Claude (my-mac)",
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "my-mac",
    metadata: {},
    owner_id: "me",
    visibility: "private",
    last_seen_at: new Date(NOW - 10_000).toISOString(),
    created_at: "2026-10-18T11:00:00Z",
    updated_at: "2026-10-18T11:00:00Z",
    ...overrides,
  };
}

function groups(runtimes: AgentRuntime[]) {
  const machines = buildRuntimeMachines(runtimes, {
    now: NOW,
    localDaemonId: "daemon-local",
    currentUserId: "me",
  });
  return buildRuntimeChoiceGroups(machines, "me");
}

describe("buildRuntimeChoiceGroups", () => {
  it("splits runtimes into this device, remote devices and cloud", () => {
    const result = groups([
      makeRuntime({ id: "local-codex", provider: "codex", name: "Codex (my-mac)" }),
      makeRuntime({ id: "local-claude" }),
      makeRuntime({
        id: "server-claude",
        daemon_id: "daemon-server",
        name: "Claude (build-01)",
        owner_id: "teammate",
        visibility: "public",
      }),
      makeRuntime({
        id: "qoder",
        daemon_id: null,
        name: "Qoder Cloud Agent",
        runtime_mode: "cloud",
        provider: "qoder_cloud",
        owner_id: "admin",
        visibility: "public",
      }),
    ]);

    expect(result.local?.harnesses.map((h) => h.runtime.id)).toEqual([
      "local-claude",
      "local-codex",
    ]);
    expect(result.remotes.map((d) => d.harnesses[0]?.runtime.id)).toEqual([
      "server-claude",
    ]);
    expect(result.qoderRuntime?.id).toBe("qoder");
    expect(result.cloud).toEqual([]);
  });

  it("counts remote devices with nothing this member may use instead of listing them", () => {
    const result = groups([
      makeRuntime({
        id: "private-elsewhere",
        daemon_id: "daemon-other",
        name: "Claude (their-mac)",
        owner_id: "teammate",
        visibility: "private",
      }),
    ]);
    expect(result.remotes).toEqual([]);
    expect(result.hiddenRemoteCount).toBe(1);
  });

  it("prefers the online Qoder runtime over a stale one", () => {
    const cloud = {
      runtime_mode: "cloud" as const,
      provider: "qoder_cloud",
      owner_id: "admin",
      visibility: "public" as const,
    };
    const result = groups([
      makeRuntime({ ...cloud, id: "qoder-old", daemon_id: "qoder", status: "offline" }),
      makeRuntime({ ...cloud, id: "qoder-new", daemon_id: "qoder" }),
    ]);
    expect(result.qoderRuntime?.id).toBe("qoder-new");
  });
});

describe("harness helpers", () => {
  const options = Array.from({ length: 10 }, (_, index) =>
    harnessOption(
      makeRuntime({ id: `rt-${index}`, name: `Harness ${index} (my-mac)` }),
      "my-mac",
    ),
  );

  it("keeps the selected harness visible in a collapsed preview", () => {
    const { shown, hiddenCount } = previewOptions(options, "rt-9", 7);
    expect(shown).toHaveLength(7);
    expect(shown.at(-1)?.runtime.id).toBe("rt-9");
    expect(hiddenCount).toBe(3);
  });

  it("matches a device by its name or by any of its harnesses", () => {
    const device = {
      machine: buildRuntimeMachines([options[0]!.runtime], { now: NOW })[0]!,
      harnesses: options.slice(0, 3),
    };
    expect(filterDevice(device, "harness 2")?.harnesses).toHaveLength(1);
    expect(filterDevice(device, "nothing-like-this")).toBeNull();
  });
});
