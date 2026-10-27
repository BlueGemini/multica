// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  starts: 0,
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
    } else if (args[0] === "daemon" && args[1] === "start" && (ctx.starts++, ctx.holdStart)) {
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
      confirmInstallWhileBusy: async () => "wait",
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
  ctx.starts = 0;
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

describe("Windows update: handoff after the daemon stop has begun", () => {
  it("a normal quit during manual preparation must retain the PID-exit barrier", async () => {
    await setupRealGate();
    downloaded();
    const manualInstall = ipc("updater:install");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.stops).toBe(1);
    expect(ctx.health).toBeNull();
    expect(ctx.processAlive).toBe(true);
    const startsBeforeHandoff = ctx.starts;
    expect(emitQuit().defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.quits).toBe(0);
    // The handoff keeps the daemon paused: nothing restarts it meanwhile.
    expect(ctx.starts).toBe(startsBeforeHandoff);
    ctx.processAlive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await manualInstall;
    expect(ctx.quits).toBe(1);
    expect(ctx.stops).toBe(1);
    expect(ctx.starts).toBe(startsBeforeHandoff);
  });

  it("manual installation during deferred shutdown must retain the PID-exit barrier", async () => {
    await setupRealGate();
    ctx.health!.active_task_count = 1;
    await ipc("updater:install");
    ctx.health!.active_task_count = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.stops).toBe(1);
    expect(ctx.health).toBeNull();
    expect(ctx.processAlive).toBe(true);
    const startsBeforeHandoff = ctx.starts;
    const manualInstall = ipc("updater:install");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.install).not.toHaveBeenCalled();
    expect(ctx.starts).toBe(startsBeforeHandoff);
    ctx.processAlive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await manualInstall;
    expect(ctx.install).toHaveBeenCalledTimes(1);
    expect(ctx.stops).toBe(1);
    expect(ctx.starts).toBe(startsBeforeHandoff);
  });
});
