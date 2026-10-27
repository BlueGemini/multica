// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (...args: unknown[]) => void;
type IpcHandler = (...args: unknown[]) => unknown;

const ctx = vi.hoisted(() => ({
  handlers: new Map<string, Handler[]>(),
  ipcHandlers: new Map<string, IpcHandler>(),
  ipcHandle: vi.fn(),
  checkForUpdates: vi.fn(async () => ({
    updateInfo: { version: "0.3.18" },
    isUpdateAvailable: false,
  })),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  getVersion: vi.fn(() => "0.3.17"),
  appHandlers: new Map<string, Handler[]>(),
  appQuit: vi.fn(),
  userDataPath: "",
}));

vi.mock("electron-updater", () => {
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: undefined as string | undefined,
    allowDowngrade: false,
    on: vi.fn((event: string, handler: Handler) => {
      const handlers = ctx.handlers.get(event) ?? [];
      handlers.push(handler);
      ctx.handlers.set(event, handlers);
      return autoUpdater;
    }),
    checkForUpdates: ctx.checkForUpdates,
    downloadUpdate: ctx.downloadUpdate,
    quitAndInstall: ctx.quitAndInstall,
  };
  return { autoUpdater };
});

vi.mock("electron", () => ({
  app: {
    getVersion: ctx.getVersion,
    getPath: vi.fn(() => ctx.userDataPath),
    on: vi.fn((event: string, handler: Handler) => {
      const handlers = ctx.appHandlers.get(event) ?? [];
      handlers.push(handler);
      ctx.appHandlers.set(event, handlers);
    }),
    quit: ctx.appQuit,
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {
    handle: ctx.ipcHandle,
  },
}));

import { autoUpdater } from "electron-updater";
import {
  configureMacX64UpdateChannel,
  createElectronBusyInstallPrompt,
  setupAutoUpdater,
  type UpdaterDaemonGate,
} from "./updater";
import type { DaemonInstallPrep } from "./update-install-gate";
import { updaterPreferencesPath } from "./updater-preferences";

describe("macOS x64 update channel", () => {
  it("does not touch established architecture paths", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
      ["linux", "arm64"],
    ] as const) {
      const updater = { channel: null, allowDowngrade: true };

      configureMacX64UpdateChannel(updater, platform, arch);

      expect(updater).toEqual({ channel: null, allowDowngrade: true });
    }
  });

  it("does not enable downgrades when selecting an architecture feed", () => {
    const updater = { channel: null, allowDowngrade: true };

    configureMacX64UpdateChannel(updater, "darwin", "x64");

    expect(updater).toEqual({
      channel: "latest-x64",
      allowDowngrade: false,
    });
  });
});

function emitUpdater(event: string, ...args: unknown[]) {
  for (const handler of ctx.handlers.get(event) ?? []) {
    handler(...args);
  }
}

async function invokeIpc(channel: string, ...args: unknown[]) {
  const handler = ctx.ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({}, ...args);
}

function makeWindow() {
  const send = vi.fn();
  return {
    win: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown as BrowserWindow,
    send,
  };
}

function makeDestroyedWindow() {
  return {
    isDestroyed: () => true,
    get webContents(): WebContents {
      throw new TypeError("Object has been destroyed");
    },
  } as unknown as BrowserWindow;
}

function makeWindowWithDestroyedWebContents() {
  const send = vi.fn(() => {
    throw new TypeError("Object has been destroyed");
  });
  return {
    win: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send,
      },
    } as unknown as BrowserWindow,
    send,
  };
}

function makeWindowWithThrowingSend(error: Error) {
  const send = vi.fn(() => {
    throw error;
  });
  return {
    win: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send,
      },
    } as unknown as BrowserWindow,
    send,
  };
}

describe("setupAutoUpdater", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctx.userDataPath = mkdtempSync(join(tmpdir(), "multica-updater-test-"));
    ctx.handlers.clear();
    ctx.ipcHandlers.clear();
    ctx.ipcHandle.mockClear();
    ctx.ipcHandle.mockImplementation((channel: string, handler: IpcHandler) => {
      ctx.ipcHandlers.set(channel, handler);
    });
    ctx.checkForUpdates.mockClear();
    ctx.downloadUpdate.mockClear();
    ctx.quitAndInstall.mockClear();
    ctx.getVersion.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(ctx.userDataPath, { recursive: true, force: true });
  });

  it("enables automatic background updates by default", async () => {
    setupAutoUpdater(() => null);

    await expect(invokeIpc("updater:get-preferences")).resolves.toEqual({
      automaticUpdates: true,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("skips startup and periodic checks when automatic updates are disabled", async () => {
    writeFileSync(
      updaterPreferencesPath(ctx.userDataPath),
      JSON.stringify({ automaticUpdates: false }),
    );
    setupAutoUpdater(() => null);

    // Let the async preference load settle before advancing timers; otherwise
    // the in-flight readFile can resolve after afterEach() removes the temp
    // dir, default back to enabled=true, and fire a background check into the
    // next test's freshly-cleared mock (flake on slow CI).
    await invokeIpc("updater:get-preferences");

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 5_000);

    expect(ctx.checkForUpdates).not.toHaveBeenCalled();
  });

  it("persists the automatic update preference and stops future background checks", async () => {
    setupAutoUpdater(() => null);

    await expect(
      invokeIpc("updater:set-automatic-updates", false),
    ).resolves.toEqual({ automaticUpdates: false });
    expect(
      JSON.parse(
        readFileSync(updaterPreferencesPath(ctx.userDataPath), "utf-8"),
      ),
    ).toEqual({ automaticUpdates: false });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 5_000);
    expect(ctx.checkForUpdates).not.toHaveBeenCalled();
  });

  it("still allows an explicit manual check when automatic updates are disabled", async () => {
    writeFileSync(
      updaterPreferencesPath(ctx.userDataPath),
      JSON.stringify({ automaticUpdates: false }),
    );
    setupAutoUpdater(() => null);

    await expect(invokeIpc("updater:check")).resolves.toMatchObject({
      ok: true,
    });

    expect(ctx.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("forwards update progress to a live renderer", () => {
    const { win, send } = makeWindow();
    setupAutoUpdater(() => win);

    emitUpdater("download-progress", { percent: 42 });

    expect(send).toHaveBeenCalledWith("updater:download-progress", {
      percent: 42,
    });
  });

  it("skips update progress when the BrowserWindow has already been destroyed", () => {
    setupAutoUpdater(() => makeDestroyedWindow());

    expect(() => emitUpdater("download-progress", { percent: 42 })).not.toThrow();
  });

  it("skips update progress when the BrowserWindow webContents has already been destroyed", () => {
    const { win, send } = makeWindowWithDestroyedWebContents();
    setupAutoUpdater(() => win);

    expect(() => emitUpdater("download-progress", { percent: 42 })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("skips update progress when webContents.send loses a destroy race", () => {
    const { win, send } = makeWindowWithThrowingSend(
      new TypeError("Object has been destroyed"),
    );
    setupAutoUpdater(() => win);

    expect(() => emitUpdater("download-progress", { percent: 42 })).not.toThrow();
    expect(send).toHaveBeenCalledWith("updater:download-progress", {
      percent: 42,
    });
  });

  it("rethrows non-destroy errors from webContents.send", () => {
    const { win } = makeWindowWithThrowingSend(new Error("boom"));
    setupAutoUpdater(() => win);

    expect(() => emitUpdater("download-progress", { percent: 42 })).toThrow(
      "boom",
    );
  });
});

describe("Windows daemon gate around update install (#8823)", () => {
  function makeGate(preps: DaemonInstallPrep[]) {
    const queue = [...preps];
    const gate = {
      prepare: vi.fn<UpdaterDaemonGate["prepare"]>(async () => queue.shift() ?? { kind: "ready" as const }),
      resumeAfterAbortedInstall: vi.fn(),
      confirmInstallWhileBusy: vi.fn(async () => "now" as const),
    } satisfies UpdaterDaemonGate;
    return gate;
  }

  function emitBeforeQuit() {
    const event = { preventDefault: vi.fn() };
    for (const handler of ctx.appHandlers.get("before-quit") ?? []) {
      handler(event);
    }
    return event;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    ctx.userDataPath = mkdtempSync(join(tmpdir(), "multica-updater-gate-"));
    ctx.handlers.clear();
    ctx.ipcHandlers.clear();
    ctx.appHandlers.clear();
    ctx.appQuit.mockClear();
    ctx.quitAndInstall.mockClear();
    ctx.ipcHandle.mockImplementation((channel: string, handler: IpcHandler) => {
      ctx.ipcHandlers.set(channel, handler);
    });
    autoUpdater.autoInstallOnAppQuit = true;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(ctx.userDataPath, { recursive: true, force: true });
  });

  it("leaves macOS and Linux installs untouched", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      ctx.quitAndInstall.mockClear();
      const gate = makeGate([]);
      setupAutoUpdater(() => null, { daemonGate: gate, platform });

      await invokeIpc("updater:install");

      expect(gate.prepare).not.toHaveBeenCalled();
      expect(ctx.quitAndInstall).toHaveBeenCalledWith(false, true);
    }
    expect(ctx.appHandlers.get("before-quit")).toBeUndefined();
  });

  it("stops an idle daemon before handing off to the installer", async () => {
    const gate = makeGate([{ kind: "ready" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");

    expect(gate.prepare).toHaveBeenCalledWith({ interruptActiveTasks: false, signal: expect.any(AbortSignal) });
    expect(gate.confirmInstallWhileBusy).not.toHaveBeenCalled();
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("still installs when the daemon does not exit in time", async () => {
    const gate = makeGate([{ kind: "timeout" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");

    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("still installs when the gate itself fails", async () => {
    const gate = makeGate([]);
    gate.prepare.mockRejectedValueOnce(new Error("boom"));
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");

    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("asks before interrupting running tasks and honours 'Install now'", async () => {
    const gate = makeGate([{ kind: "busy", activeTasks: 2 }, { kind: "ready" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");

    expect(gate.confirmInstallWhileBusy).toHaveBeenCalledWith(2);
    expect(gate.prepare).toHaveBeenLastCalledWith({ interruptActiveTasks: true, signal: expect.any(AbortSignal) });
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does nothing on 'Cancel'", async () => {
    const gate = makeGate([{ kind: "busy", activeTasks: 1 }]);
    gate.confirmInstallWhileBusy.mockResolvedValueOnce("cancel" as never);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(gate.prepare).toHaveBeenCalledTimes(1);
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs once tasks finish on 'Install when tasks finish'", async () => {
    const gate = makeGate([
      { kind: "busy", activeTasks: 1 },
      { kind: "busy", activeTasks: 1 },
      { kind: "ready" },
    ]);
    gate.confirmInstallWhileBusy.mockResolvedValueOnce("wait" as never);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(gate.prepare).toHaveBeenCalledWith({ interruptActiveTasks: false, signal: expect.any(AbortSignal) });
    expect(gate.prepare).not.toHaveBeenCalledWith(expect.objectContaining({ interruptActiveTasks: true }));
  });

  it("resumes the daemon when quitAndInstall never quits the app", async () => {
    const gate = makeGate([{ kind: "ready" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(gate.resumeAfterAbortedInstall).toHaveBeenCalledTimes(1);
  });

  it("lets manual Install now supersede a deferred check without installing twice", async () => {
    let finishProbe!: (prep: DaemonInstallPrep) => void;
    const gate = makeGate([]);
    gate.prepare
      .mockResolvedValueOnce({ kind: "busy", activeTasks: 1 })
      .mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }))
      .mockResolvedValueOnce({ kind: "busy", activeTasks: 1 })
      .mockResolvedValueOnce({ kind: "ready" });
    gate.confirmInstallWhileBusy
      .mockResolvedValueOnce("wait" as never)
      .mockResolvedValueOnce("now");
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    await vi.advanceTimersByTimeAsync(10_000);
    const deferredSignal = gate.prepare.mock.calls[1][0].signal!;
    await invokeIpc("updater:install");
    expect(deferredSignal.aborted).toBe(true);
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);

    finishProbe({ kind: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(gate.prepare).toHaveBeenCalledTimes(4);
  });

  it("ignores a manual dialog result after quit takes ownership", async () => {
    let choose!: (choice: "now") => void;
    const gate = makeGate([{ kind: "busy", activeTasks: 1 }, { kind: "ready" }]);
    gate.confirmInstallWhileBusy.mockImplementationOnce(() => new Promise((resolve) => { choose = resolve; }));
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });
    emitUpdater("update-downloaded", { version: "0.3.18" });

    const manualInstall = invokeIpc("updater:install");
    await vi.advanceTimersByTimeAsync(0);
    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);
    choose("now");
    await manualInstall;

    expect(ctx.appQuit).toHaveBeenCalledTimes(1);
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();
    expect(gate.prepare).toHaveBeenCalledTimes(2);
  });

  it("does not resume the daemon once the app is quitting", async () => {
    const gate = makeGate([{ kind: "ready" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    const event = emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(gate.resumeAfterAbortedInstall).not.toHaveBeenCalled();
  });

  it("does not gate a quit when no update is downloaded", () => {
    const gate = makeGate([]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    const event = emitBeforeQuit();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(gate.prepare).not.toHaveBeenCalled();
  });

  it("stops an idle daemon before the quit-time install", async () => {
    const gate = makeGate([{ kind: "ready" }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });
    emitUpdater("update-downloaded", { version: "0.3.18" });

    const event = emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(gate.prepare).toHaveBeenCalledWith({ interruptActiveTasks: false, signal: expect.any(AbortSignal) });
    expect(ctx.appQuit).toHaveBeenCalledTimes(1);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    // The re-entered quit passes straight through.
    expect(emitBeforeQuit().preventDefault).not.toHaveBeenCalled();
  });

  it("skips the quit-time install instead of killing running tasks", async () => {
    const gate = makeGate([{ kind: "busy", activeTasks: 3 }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });
    emitUpdater("update-downloaded", { version: "0.3.18" });

    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);

    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(ctx.appQuit).toHaveBeenCalledTimes(1);
  });

  it("hands a deferred flow to a manual install without resuming the daemon", async () => {
    const gate = makeGate([]);
    gate.prepare
      .mockResolvedValueOnce({ kind: "busy", activeTasks: 1 })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ kind: "ready" });
    gate.confirmInstallWhileBusy.mockResolvedValueOnce("wait" as never);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");
    gate.resumeAfterAbortedInstall.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    await invokeIpc("updater:install");

    expect(gate.resumeAfterAbortedInstall).not.toHaveBeenCalled();
    expect(ctx.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("hands a manual flow to the quit flow without resuming the daemon", async () => {
    const gate = makeGate([]);
    gate.prepare
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ kind: "ready" });
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });
    emitUpdater("update-downloaded", { version: "0.3.18" });

    void invokeIpc("updater:install");
    await vi.advanceTimersByTimeAsync(0);
    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.resumeAfterAbortedInstall).not.toHaveBeenCalled();
    expect(ctx.appQuit).toHaveBeenCalledTimes(1);
  });

  it("resumes an inherited pause when the successor flow does not install", async () => {
    const gate = makeGate([{ kind: "busy", activeTasks: 1 }]);
    gate.confirmInstallWhileBusy.mockResolvedValueOnce("cancel" as never);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });

    await invokeIpc("updater:install");

    expect(gate.resumeAfterAbortedInstall).toHaveBeenCalledTimes(1);
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();
  });

  it("resumes before a quit that skips the install for running tasks", async () => {
    const gate = makeGate([{ kind: "busy", activeTasks: 2 }]);
    setupAutoUpdater(() => null, { daemonGate: gate, platform: "win32" });
    emitUpdater("update-downloaded", { version: "0.3.18" });

    emitBeforeQuit();
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.resumeAfterAbortedInstall).toHaveBeenCalledTimes(1);
    expect(ctx.appQuit).toHaveBeenCalledTimes(1);
  });
});

describe("createElectronBusyInstallPrompt", () => {
  it("maps dialog buttons to choices", async () => {
    for (const [response, choice] of [
      [0, "wait"],
      [1, "now"],
      [2, "cancel"],
    ] as const) {
      const showMessageBox = vi.fn(async () => ({ response }));
      const prompt = createElectronBusyInstallPrompt(showMessageBox);

      await expect(prompt(2)).resolves.toBe(choice);
      expect(showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          cancelId: 2,
          message: "2 agent tasks are running on this computer.",
        }),
      );
    }
  });
});
