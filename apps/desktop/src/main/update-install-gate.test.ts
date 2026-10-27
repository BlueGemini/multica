// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  prepareDaemonForInstall,
  type DaemonInstallGateDeps,
  type DaemonInstallProbe,
} from "./update-install-gate";

const running = (overrides: Partial<DaemonInstallProbe> = {}): DaemonInstallProbe => ({
  alive: true,
  pid: 4242,
  activeTasks: 0,
  externallyManaged: false,
  ...overrides,
});

function makeDeps(
  probes: (DaemonInstallProbe | null)[],
  overrides: Partial<DaemonInstallGateDeps> = {},
) {
  let clock = 0;
  const queue = [...probes];
  const last = probes[probes.length - 1] ?? null;
  const deps: DaemonInstallGateDeps = {
    probe: vi.fn(async () => (queue.length > 0 ? queue.shift()! : last)),
    stop: vi.fn(async () => {}),
    processExists: vi.fn(() => false),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    ...overrides,
  };
  return deps;
}

describe("prepareDaemonForInstall", () => {
  it("does not stop after cancellation during the initial probe", async () => {
    const controller = new AbortController();
    const deps = makeDeps([running()], {
      probe: vi.fn(async () => {
        controller.abort();
        return running();
      }),
    });

    await expect(
      prepareDaemonForInstall(deps, {
        interruptActiveTasks: false,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("is ready without stopping when no managed daemon exists", async () => {
    for (const probe of [null, running({ alive: false }), running({ externallyManaged: true })]) {
      const deps = makeDeps([probe]);
      await expect(
        prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
      ).resolves.toEqual({ kind: "ready" });
      expect(deps.stop).not.toHaveBeenCalled();
    }
  });

  it("reports busy without touching a daemon that has active tasks", async () => {
    const deps = makeDeps([running({ activeTasks: 2 })]);

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "busy", activeTasks: 2 });
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("stops a busy daemon when interrupting is allowed", async () => {
    const deps = makeDeps([running({ activeTasks: 2 }), null]);

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: true }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for the process to exit, not just for /health to disappear", async () => {
    let exists = true;
    const deps = makeDeps([running(), null], {
      processExists: vi.fn(() => exists),
    });
    vi.mocked(deps.sleep).mockImplementation(async () => {
      // Process lingers for a couple of polls after health is gone.
      if (vi.mocked(deps.sleep).mock.calls.length >= 3) exists = false;
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.processExists).toHaveBeenCalledWith(4242);
    expect(vi.mocked(deps.sleep).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("times out when the daemon never exits", async () => {
    const deps = makeDeps([running()]);

    await expect(
      prepareDaemonForInstall(deps, {
        interruptActiveTasks: false,
        timeoutMs: 1_000,
        pollIntervalMs: 250,
      }),
    ).resolves.toEqual({ kind: "timeout" });
  });

  it("still waits for exit when the stop request fails", async () => {
    const deps = makeDeps([running(), null], {
      stop: vi.fn(async () => {
        throw new Error("exec failed");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "ready" });
    warn.mockRestore();
  });

  it("does not hang behind a stop that never settles", async () => {
    let clock = 0;
    let stopSignal: AbortSignal | undefined;
    const deps = makeDeps([running()], {
      stop: vi.fn((signal) => {
        stopSignal = signal;
        return new Promise<void>(() => {});
      }),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false, timeoutMs: 1_000 }),
    ).resolves.toEqual({ kind: "timeout" });
    expect(stopSignal?.aborted).toBe(true);
  });

  it("passes the PID barrier to stop and clears it once the process exits", async () => {
    const deps = makeDeps([running(), null], { clearPendingExits: vi.fn() });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false, timeoutMs: 1_000 }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.stop).toHaveBeenCalledWith(expect.any(AbortSignal), {
      pid: 4242,
      deadline: 1_000,
    });
    expect(deps.clearPendingExits).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting on an inherited barrier when /health is already gone", async () => {
    let clock = 5_000;
    let exists = true;
    const deps = makeDeps([null], {
      pendingExits: () => [{ pid: 4242, deadline: 6_000 }],
      clearPendingExits: vi.fn(),
      processExists: vi.fn(() => exists),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
        if (clock >= 5_500) exists = false;
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.processExists).toHaveBeenCalledWith(4242);
    expect(clock).toBeGreaterThanOrEqual(5_500);
    expect(deps.clearPendingExits).toHaveBeenCalledTimes(1);
  });

  it("an inherited barrier keeps its original deadline", async () => {
    let clock = 5_000;
    const deps = makeDeps([null], {
      pendingExits: () => [{ pid: 4242, deadline: 6_000 }],
      processExists: vi.fn(() => true),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "timeout" });
    expect(clock).toBe(6_000);
  });

  it("does not clear an inherited barrier when it is cancelled", async () => {
    const controller = new AbortController();
    const deps = makeDeps([null], {
      pendingExits: () => [{ pid: 4242, deadline: 60_000 }],
      clearPendingExits: vi.fn(),
      processExists: vi.fn(() => true),
      sleep: vi.fn(async () => {
        controller.abort();
      }),
    });

    await expect(
      prepareDaemonForInstall(deps, {
        interruptActiveTasks: false,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(deps.clearPendingExits).not.toHaveBeenCalled();
  });

  it("inherits the issued stop and its deadline while health still responds", async () => {
    // The first flow stopped PID 4242 at t=0 (deadline 15s). At t=10s the same
    // daemon still answers /health; the successor must use the remaining 5s
    // and must not issue a second stop.
    let clock = 10_000;
    const deps = makeDeps([running()], {
      pendingExits: () => [{ pid: 4242, deadline: 15_000 }],
      clearPendingExits: vi.fn(),
      processExists: vi.fn(() => true),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "timeout" });
    expect(deps.stop).not.toHaveBeenCalled();
    expect(clock).toBe(15_000);
    expect(deps.clearPendingExits).toHaveBeenCalledTimes(1);
  });

  it("does not report busy for a daemon whose stop was already issued", async () => {
    const deps = makeDeps([running({ activeTasks: 2 }), null], {
      pendingExits: () => [{ pid: 4242, deadline: 60_000 }],
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("stops a new PID but keeps waiting for the inherited one", async () => {
    let clock = 1_000;
    const alive = new Set([4242, 5151]);
    const deps = makeDeps([running({ pid: 5151 }), null], {
      pendingExits: () => [{ pid: 4242, deadline: 15_000 }],
      clearPendingExits: vi.fn(),
      stop: vi.fn(async () => {
        alive.delete(5151);
      }),
      processExists: vi.fn((pid: number) => alive.has(pid)),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
        if (clock >= 3_000) alive.delete(4242);
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "ready" });
    expect(deps.stop).toHaveBeenCalledWith(expect.any(AbortSignal), {
      pid: 5151,
      deadline: 16_000,
    });
    // Not ready until the old PID exited, even though the new one left at once.
    expect(clock).toBeGreaterThanOrEqual(3_000);
    expect(deps.clearPendingExits).toHaveBeenCalledTimes(1);
  });

  it("an inherited PID stops blocking at its own deadline and reports timeout", async () => {
    let clock = 10_000;
    const deps = makeDeps([running({ pid: 5151 }), null], {
      pendingExits: () => [{ pid: 4242, deadline: 15_000 }],
      processExists: vi.fn((pid: number) => pid === 4242),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "timeout" });
    // The new PID exited at once; only the draining old PID caused the timeout.
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.processExists).toHaveBeenCalledWith(4242);
  });

  it("keeps inherited barriers when a new PID is busy", async () => {
    const deps = makeDeps([running({ pid: 5151, activeTasks: 1 })], {
      pendingExits: () => [{ pid: 4242, deadline: 15_000 }],
      clearPendingExits: vi.fn(),
    });

    await expect(
      prepareDaemonForInstall(deps, { interruptActiveTasks: false }),
    ).resolves.toEqual({ kind: "busy", activeTasks: 1 });
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.clearPendingExits).not.toHaveBeenCalled();
  });
});
