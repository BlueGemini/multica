// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonInstallPrep } from "./update-install-gate";
import type { UpdaterDaemonGate } from "./updater";

type Health = {
  status: string;
  pid: number;
  active_task_count: number;
  cli_version: string;
};
type Handler = (...args: unknown[]) => void;
type IpcHandler = (...args: unknown[]) => unknown;

const ctx = vi.hoisted(() => ({
  listeners: new Map<string, Handler[]>(),
  updaterListeners: new Map<string, Handler[]>(),
  ipc: new Map<string, IpcHandler>(),
  health: null as Health | null,
  processAlive: true,
  autoStop: false,
  quits: 0,
  stops: 0,
  holdStart: false,
  finishStart: null as null | (() => void),
  quit: vi.fn(),
  install: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: (name: string, listener: Handler) => {
      ctx.listeners.set(name, [...(ctx.listeners.get(name) ?? []), listener]);
    },
    quit: ctx.quit,
    getPath: () => "/review-only/user-data",
    getAppPath: () => "/review-only/app",
    getVersion: () => "0.7.0",
  },
  BrowserWindow: class {},
  ipcMain: {
    handle: (name: string, fn: IpcHandler) => ctx.ipc.set(name, fn),
    on: vi.fn(),
  },
  shell: { openPath: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoInstallOnAppQuit: true,
    quitAndInstall: ctx.install,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(),
    on: (name: string, fn: Handler) => {
      ctx.updaterListeners.set(name, [...(ctx.updaterListeners.get(name) ?? []), fn]);
    },
  },
}));

vi.mock("./updater-preferences", () => ({
  DEFAULT_UPDATER_PREFERENCES: { automaticUpdates: false },
  updaterPreferencesPath: () => "/review-only/updater-preferences.json",
  loadUpdaterPreferences: async () => ({ automaticUpdates: false }),
  saveUpdaterPreferences: vi.fn(),
}));

vi.mock("./cli-bootstrap", () => ({
  managedCliPath: () => "/review-only/managed-cli",
  ensureManagedCli: vi.fn(async () => "/review-only/managed-cli"),
}));

vi.mock("fs", () => ({
  existsSync: () => true,
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith("desktop_prefs.json")) {
      return JSON.stringify({ autoStart: true, autoStop: ctx.autoStop });
    }
    if (path.endsWith("daemon.pid")) return "4242";
    return JSON.stringify({ server_url: "https://review.invalid" });
  }),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("./daemon-port", () => ({
  probeProfileHealth: vi.fn(async () => ctx.health),
}));
vi.mock("child_process", () => ({
  execFile: vi.fn((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    if (args[0] === "version") cb(null, '{"version":"0.7.0"}');
    else if (args[0] === "daemon" && args[1] === "stop") {
      ctx.stops++;
      ctx.health = null;
      // CLI success and /health disappearing do not prove that PID 4242 exited.
      cb(null, "");
    } else if (args[0] === "daemon" && args[1] === "start" && ctx.holdStart) {
      ctx.health = { status: "starting", pid: 4343, active_task_count: 0, cli_version: "0.7.0" };
      ctx.finishStart = () => cb(null, "");
    } else cb(null, "");
  }),
}));

function emitQuit() {
  const event = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  for (const listener of ctx.listeners.get("before-quit") ?? []) listener(event);
  if (!event.defaultPrevented) ctx.quits++;
  return event;
}

function downloaded() {
  for (const fn of ctx.updaterListeners.get("update-downloaded") ?? []) fn({ version: "0.7.1" });
}

async function ipc(name: string) {
  return ctx.ipc.get(name)!({});
}

async function setupRealGate() {
  const manager = await import("./daemon-manager");
  const { setupAutoUpdater } = await import("./updater");
  setupAutoUpdater(() => null, {
    platform: "win32",
    daemonGate: {
      prepare: manager.prepareDaemonForUpdateInstall,
      resumeAfterAbortedInstall: manager.resumeDaemonAfterAbortedUpdateInstall,
      confirmInstallWhileBusy: async () => "cancel",
    },
  });
  manager.setupDaemonManager(() => null);
  await ctx.ipc.get("daemon:set-target-api-url")!({}, "https://review.invalid");
  await ipc("daemon:auto-start");
  await vi.advanceTimersByTimeAsync(0);
  return manager;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  ctx.listeners.clear();
  ctx.updaterListeners.clear();
  ctx.ipc.clear();
  ctx.autoStop = false;
  ctx.quits = 0;
  ctx.stops = 0;
  ctx.processAlive = true;
  ctx.holdStart = false;
  ctx.finishStart = null;
  ctx.health = { status: "running", pid: 4242, active_task_count: 0, cli_version: "0.7.0" };
  ctx.quit.mockReset().mockImplementation(emitQuit);
  ctx.install.mockReset();
  // Never probe or signal a real process.
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (ctx.processAlive) return true;
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Windows update and daemon lifecycle coordination", () => {
  it("autoStop must not re-enter quit before the update gate confirms process exit", async () => {
    ctx.autoStop = true;
    await setupRealGate();
    downloaded();
    expect(emitQuit().defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.stops).toBeGreaterThan(0);
    // The process still exists, well before the 15s fallback deadline.
    expect(ctx.quits).toBe(0);
    ctx.processAlive = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.quits).toBe(1);
    expect(ctx.stops).toBe(1);
  });

  it("a second quit must still wait while preparation is unresolved", async () => {
    await setupRealGate();
    downloaded();
    expect(emitQuit().defaultPrevented).toBe(true);
    expect(emitQuit().defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ctx.quits).toBe(1);
  });

  it("documents the fail-open path: missing health returns ready without checking the PID", async () => {
    const manager = await setupRealGate();
    ctx.health = null;
    vi.mocked(process.kill).mockClear();
    const result = await manager.prepareDaemonForUpdateInstall({ interruptActiveTasks: false });
    expect(result.kind).toBe("ready");
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each(["busy", "ready", "error"] as const)("Cancel invalidates a deferred probe that later returns %s", async (result) => {
    const { setupAutoUpdater } = await import("./updater");
    let finishProbe!: (prep: DaemonInstallPrep) => void;
    let rejectProbe!: (err: Error) => void;
    const prepare = vi.fn<UpdaterDaemonGate["prepare"]>()
      .mockResolvedValueOnce({ kind: "busy", activeTasks: 1 })
      .mockImplementationOnce(() => new Promise<DaemonInstallPrep>((resolve, reject) => {
        finishProbe = resolve;
        rejectProbe = reject;
      }))
      .mockResolvedValueOnce({ kind: "busy", activeTasks: 1 })
      .mockResolvedValue({ kind: "ready" });
    setupAutoUpdater(() => null, {
      platform: "win32",
      daemonGate: {
        prepare,
        resumeAfterAbortedInstall: vi.fn(),
        confirmInstallWhileBusy: vi.fn().mockResolvedValueOnce("wait").mockResolvedValueOnce("cancel"),
      },
    });
    await ipc("updater:install");
    await vi.advanceTimersByTimeAsync(10_000);
    const deferredSignal = prepare.mock.calls[1][0].signal!;
    await ipc("updater:install");
    expect(deferredSignal.aborted).toBe(true);
    if (result === "error") rejectProbe(new Error("late probe failure"));
    else if (result === "busy") finishProbe({ kind: "busy", activeTasks: 1 });
    else finishProbe({ kind: "ready" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(ctx.install).not.toHaveBeenCalled();
  });

  it.each([20_000, 25_000])("an expired queued stop cannot kill later tasks when the start finishes at %ims", async (finishAt) => {
    await setupRealGate();
    ctx.holdStart = true;
    // The daemon serves "starting" health while its CLI child awaits preflight.
    // The existing lifecycle queue permits a 60s start operation.
    const restart = ipc("daemon:restart");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.finishStart).not.toBeNull();
    const priorStops = ctx.stops;
    const install = ipc("updater:install");
    await vi.advanceTimersByTimeAsync(15_000);
    await install;
    expect(ctx.install).toHaveBeenCalledTimes(1);
    // The installer does not quit. Check both before and after watchdog recovery.
    await vi.advanceTimersByTimeAsync(finishAt - 15_000);
    ctx.health!.status = "running";
    ctx.health!.active_task_count = 1;
    ctx.finishStart!();
    await restart;
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.stops).toBe(priorStops);
  });
});
