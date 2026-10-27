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
});
