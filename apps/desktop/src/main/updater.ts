import { autoUpdater, type UpdateDownloadedEvent } from "electron-updater";
import { app, type BrowserWindow, ipcMain } from "electron";
import type {
  ManualUpdateCheckResult,
  UpdaterPreferences,
} from "../shared/updater-types";
import {
  DEFAULT_UPDATER_PREFERENCES,
  loadUpdaterPreferences,
  saveUpdaterPreferences,
  updaterPreferencesPath,
} from "./updater-preferences";
import type { DaemonInstallPrep } from "./update-install-gate";

// Silent background updates: electron-updater downloads on its own as soon
// as `update-available` fires; we only surface UI when the package is fully
// downloaded and ready to install on next quit.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Windows arm64 ships its own update metadata channel because
// electron-builder's `latest.yml` is not arch-suffixed on Windows — both
// arches would otherwise collide on the same file in the GitHub Release.
// See scripts/package.mjs (builderArgsForTarget) for the publish-side half
// of this pact. Pin the channel here so arm64 clients fetch
// `latest-arm64.yml` instead of the x64 metadata.
if (process.platform === "win32" && process.arch === "arm64") {
  autoUpdater.channel = "latest-arm64";
}

interface ChannelConfigurableUpdater {
  channel: string | null;
  allowDowngrade: boolean;
}

export function configureMacX64UpdateChannel(
  updater: ChannelConfigurableUpdater,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform !== "darwin" || arch !== "x64") return;

  // AppUpdater.channel enables allowDowngrade as a side effect. This channel
  // isolates a CPU architecture, not a release train, so preserve normal
  // monotonic version behavior after selecting the architecture feed.
  updater.channel = "latest-x64";
  updater.allowDowngrade = false;
}

// electron-builder does not architecture-suffix macOS update metadata.
// package.mjs publishes macOS x64 as `latest-x64-mac.yml`; the established
// arm64 feed and runtime path remain unchanged.
configureMacX64UpdateChannel(autoUpdater);

const STARTUP_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// How often a "install when tasks finish" choice re-checks the daemon.
const DEFERRED_INSTALL_POLL_MS = 10_000;
// quitAndInstall only quits once the installer has been spawned. If the app is
// still running this long afterwards, the install bailed and the daemon we
// stopped for it must be brought back.
const INSTALL_QUIT_WATCHDOG_MS = 10_000;

export type BusyInstallChoice = "wait" | "now" | "cancel";

/**
 * Windows-only hook that lets the updater stop the bundled daemon before the
 * NSIS installer runs, so the locked `multica.exe` actually gets replaced
 * (GitHub #8823). Injected from index.ts to keep this module free of
 * daemon-manager's state.
 */
export interface UpdaterDaemonGate {
  prepare: (options: {
    interruptActiveTasks: boolean;
    signal?: AbortSignal;
  }) => Promise<DaemonInstallPrep>;
  resumeAfterAbortedInstall: () => void;
  confirmInstallWhileBusy: (activeTasks: number) => Promise<BusyInstallChoice>;
}

export interface SetupAutoUpdaterOptions {
  daemonGate?: UpdaterDaemonGate;
  platform?: NodeJS.Platform;
}

type BusyInstallMessageBoxOptions = {
  type: "question";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  title: string;
  message: string;
  detail: string;
};

export function createElectronBusyInstallPrompt(
  showMessageBox: (
    options: BusyInstallMessageBoxOptions,
  ) => Promise<{ response: number }>,
): (activeTasks: number) => Promise<BusyInstallChoice> {
  return async (activeTasks) => {
    const tasks = activeTasks === 1 ? "1 agent task is" : `${activeTasks} agent tasks are`;
    const { response } = await showMessageBox({
      type: "question",
      buttons: ["Install when tasks finish", "Install now", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Install update",
      message: `${tasks} running on this computer.`,
      detail:
        "Installing now stops the local runtime and interrupts them. " +
        "Choose \"Install when tasks finish\" to restart and update automatically once they are done.",
    });
    if (response === 0) return "wait";
    if (response === 1) return "now";
    return "cancel";
  };
}

type RendererChannel =
  | "updater:update-available"
  | "updater:download-progress"
  | "updater:update-downloaded";

function isDestroyedObjectError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Object has been destroyed");
}

function sendToLiveRenderer(
  win: BrowserWindow | null,
  channel: RendererChannel,
  payload: unknown,
): void {
  if (!win || win.isDestroyed()) return;

  try {
    const { webContents } = win;
    if (webContents.isDestroyed()) return;
    webContents.send(channel, payload);
  } catch (err) {
    if (isDestroyedObjectError(err)) return;
    throw err;
  }
}

// Single-flight guard around checkForUpdates(). With autoDownload=true the
// startup, periodic, and manual triggers can all kick off downloads, and
// overlapping calls have caused duplicate download warnings in the past
// (see electronjs.org/docs/latest/api/auto-updater). Coalesce concurrent
// callers onto the same in-flight promise.
let inFlightCheck: Promise<unknown> | null = null;
function checkForUpdatesOnce(): Promise<unknown> {
  if (inFlightCheck) return inFlightCheck;
  const p = autoUpdater
    .checkForUpdates()
    .then((result) => {
      // checkForUpdates resolves as soon as metadata is fetched; the actual
      // download (when autoDownload=true) is exposed on result.downloadPromise.
      // Without a handler a download failure becomes an unhandled rejection
      // in the main process — Node may terminate it on future versions.
      void (result as { downloadPromise?: Promise<unknown> } | null)?.downloadPromise?.catch(
        (err) => {
          console.error("Failed to download update:", err);
        },
      );
      return result;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });
  inFlightCheck = p;
  return p;
}

export function setupAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  options: SetupAutoUpdaterOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  // Only Windows locks a running executable against replacement; macOS and
  // Linux keep their existing update path untouched.
  const daemonGate = platform === "win32" ? (options.daemonGate ?? null) : null;
  const preferencesFilePath = updaterPreferencesPath(app.getPath("userData"));
  let automaticUpdatesEnabled =
    DEFAULT_UPDATER_PREFERENCES.automaticUpdates;
  let startupCheckElapsed = false;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  const preferencesReady = loadUpdaterPreferences(preferencesFilePath).then(
    (preferences) => {
      automaticUpdatesEnabled = preferences.automaticUpdates;
      return preferences;
    },
  );

  const runAutomaticCheck = (errorMessage: string): void => {
    void preferencesReady
      .then(() => {
        if (!automaticUpdatesEnabled) return;
        return checkForUpdatesOnce();
      })
      .catch((err) => {
        console.error(errorMessage, err);
      });
  };

  // Arm the startup + periodic background checks. Idempotent: an already-armed
  // timer is left in place so re-enabling never stacks duplicate schedules.
  const scheduleBackgroundChecks = (): void => {
    if (startupTimer === null && !startupCheckElapsed) {
      // Initial check shortly after startup so we don't block boot.
      startupTimer = setTimeout(() => {
        startupTimer = null;
        startupCheckElapsed = true;
        runAutomaticCheck("Failed to check for updates:");
      }, STARTUP_CHECK_DELAY_MS);
    }
    if (periodicTimer === null) {
      // Background poll so long-running sessions still pick up new releases
      // without requiring the user to restart the app.
      periodicTimer = setInterval(() => {
        runAutomaticCheck("Periodic update check failed:");
      }, PERIODIC_CHECK_INTERVAL_MS);
    }
  };

  // Tear down the scheduled checks outright when automatic updates are turned
  // off. Relying only on an in-callback preference guard leaves the timers
  // running and lets a tick that races the preference flip still fire a check;
  // clearing them makes "disabled" mean no future background work, full stop.
  const cancelBackgroundChecks = (): void => {
    if (startupTimer !== null) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (periodicTimer !== null) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  };

  // --- Windows: stop the bundled daemon before the installer runs ---------
  let updateReadyToInstall = false;
  let appQuitting = false;
  let installStarted = false;
  let quitGateHandled = false;
  type InstallFlow = {
    kind: "manual" | "deferred" | "quit";
    controller: AbortController;
  };
  let activeInstallFlow: InstallFlow | null = null;
  let deferredInstallGeneration = 0;
  let deferredInstallTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelActiveInstallFlow = (): void => {
    if (!activeInstallFlow) return;
    activeInstallFlow.controller.abort();
    activeInstallFlow = null;
    daemonGate?.resumeAfterAbortedInstall();
  };

  const cancelDeferredInstall = (): void => {
    deferredInstallGeneration += 1;
    if (deferredInstallTimer !== null) {
      clearTimeout(deferredInstallTimer);
      deferredInstallTimer = null;
    }
    if (activeInstallFlow?.kind === "deferred") cancelActiveInstallFlow();
  };

  const isCurrentFlow = (flow: InstallFlow): boolean =>
    activeInstallFlow === flow && !flow.controller.signal.aborted;

  const startInstall = (flow: InstallFlow): void => {
    if (installStarted || !isCurrentFlow(flow)) return;
    activeInstallFlow = null;
    installStarted = true;
    cancelDeferredInstall();
    setTimeout(() => {
      if (appQuitting) return;
      console.warn("[updater] install did not quit the app; resuming the daemon");
      installStarted = false;
      daemonGate?.resumeAfterAbortedInstall();
    }, INSTALL_QUIT_WATCHDOG_MS);
    autoUpdater.quitAndInstall(false, true);
  };

  // "Install when tasks finish": re-check periodically and install once the
  // daemon is idle. Clicking "Restart to update" again re-runs the full flow,
  // so "Install now" stays reachable if tasks keep arriving.
  const scheduleDeferredInstall = (generation: number): void => {
    deferredInstallTimer = setTimeout(async () => {
      deferredInstallTimer = null;
      if (
        generation !== deferredInstallGeneration ||
        !daemonGate ||
        installStarted ||
        activeInstallFlow ||
        appQuitting
      ) {
        return;
      }
      const flow: InstallFlow = {
        kind: "deferred",
        controller: new AbortController(),
      };
      activeInstallFlow = flow;
      try {
        const prep = await daemonGate.prepare({
          interruptActiveTasks: false,
          signal: flow.controller.signal,
        });
        if (!isCurrentFlow(flow)) return;
        if (prep.kind === "busy") {
          scheduleDeferredInstall(generation);
        } else if (prep.kind !== "cancelled") {
          startInstall(flow);
        }
      } catch (err) {
        if (isCurrentFlow(flow)) {
          console.error("[updater] deferred install check failed:", err);
          scheduleDeferredInstall(generation);
        }
      } finally {
        if (isCurrentFlow(flow)) activeInstallFlow = null;
      }
    }, DEFERRED_INSTALL_POLL_MS);
  };

  const installWithDaemonGate = async (): Promise<void> => {
    if (
      !daemonGate ||
      installStarted ||
      appQuitting ||
      (activeInstallFlow && activeInstallFlow.kind !== "deferred")
    ) {
      return;
    }
    // A manual choice supersedes both the timer and a probe already in flight.
    cancelDeferredInstall();
    const flow: InstallFlow = {
      kind: "manual",
      controller: new AbortController(),
    };
    activeInstallFlow = flow;
    try {
      let prep = await daemonGate.prepare({
        interruptActiveTasks: false,
        signal: flow.controller.signal,
      });
      if (!isCurrentFlow(flow)) return;
      if (prep.kind === "busy") {
        const choice = await daemonGate.confirmInstallWhileBusy(prep.activeTasks);
        if (!isCurrentFlow(flow)) return;
        if (choice === "cancel") return;
        if (choice === "wait") {
          scheduleDeferredInstall(deferredInstallGeneration);
          return;
        }
        prep = await daemonGate.prepare({
          interruptActiveTasks: true,
          signal: flow.controller.signal,
        });
      }
      if (!isCurrentFlow(flow) || prep.kind === "cancelled") return;
      if (prep.kind === "timeout") {
        // Same as the pre-gate behaviour: the installer handles the process.
        console.warn("[updater] daemon did not exit before install; continuing");
      }
      startInstall(flow);
    } catch (err) {
      if (!isCurrentFlow(flow)) return;
      // The gate must never make updating impossible.
      console.error("[updater] pre-install daemon stop failed; installing anyway:", err);
      startInstall(flow);
    } finally {
      if (isCurrentFlow(flow)) activeInstallFlow = null;
    }
  };

  if (daemonGate) {
    // autoInstallOnAppQuit: a normal quit with a downloaded update runs the
    // installer silently. Stop an idle daemon first so its binary is replaced;
    // with tasks running, skip this quit's install rather than letting the
    // installer kill them — the update stays downloaded for a later quit or
    // "Restart to update".
    app.on("before-quit", (event) => {
      if (
        installStarted ||
        quitGateHandled ||
        !updateReadyToInstall ||
        !autoUpdater.autoInstallOnAppQuit
      ) {
        appQuitting = true;
        return;
      }
      event.preventDefault();
      // Every quit remains intercepted until this preparation settles.
      if (activeInstallFlow?.kind === "quit") return;
      cancelDeferredInstall();
      cancelActiveInstallFlow();
      const flow: InstallFlow = {
        kind: "quit",
        controller: new AbortController(),
      };
      activeInstallFlow = flow;
      void daemonGate
        .prepare({ interruptActiveTasks: false, signal: flow.controller.signal })
        .then((prep) => {
          if (prep.kind === "busy") {
            console.warn(
              `[updater] ${prep.activeTasks} task(s) running; deferring install to a later quit`,
            );
            autoUpdater.autoInstallOnAppQuit = false;
          }
        })
        .catch((err) => {
          console.error("[updater] pre-quit daemon stop failed:", err);
        })
        .finally(() => {
          activeInstallFlow = null;
          quitGateHandled = true;
          appQuitting = true;
          app.quit();
        });
    });
  }

  autoUpdater.on("update-available", (info) => {
    // Forwarded for renderer-side state tracking only; the notification UI
    // does not render an "available" affordance with autoDownload=true.
    sendToLiveRenderer(getMainWindow(), "updater:update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendToLiveRenderer(getMainWindow(), "updater:download-progress", {
      percent: progress.percent,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    updateReadyToInstall = true;
    sendToLiveRenderer(getMainWindow(), "updater:update-downloaded", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
  });

  // Retained for IPC back-compat with older renderer bundles. With
  // autoDownload=true the renderer no longer triggers this path.
  ipcMain.handle("updater:download", () => {
    return autoUpdater.downloadUpdate();
  });

  ipcMain.handle("updater:install", async () => {
    if (!daemonGate) {
      autoUpdater.quitAndInstall(false, true);
      return;
    }
    await installWithDaemonGate();
  });

  ipcMain.handle(
    "updater:get-preferences",
    async (): Promise<UpdaterPreferences> => {
      await preferencesReady;
      return { automaticUpdates: automaticUpdatesEnabled };
    },
  );

  ipcMain.handle(
    "updater:set-automatic-updates",
    async (_event, enabled: unknown): Promise<UpdaterPreferences> => {
      if (typeof enabled !== "boolean") {
        throw new TypeError("automaticUpdates must be a boolean");
      }

      await preferencesReady;
      const wasEnabled = automaticUpdatesEnabled;
      const preferences = { automaticUpdates: enabled };
      await saveUpdaterPreferences(preferencesFilePath, preferences);
      automaticUpdatesEnabled = enabled;

      if (!enabled) {
        cancelBackgroundChecks();
      } else if (!wasEnabled) {
        // If the startup check has already passed while the preference was off,
        // enabling it should take effect now instead of waiting up to one hour.
        if (startupCheckElapsed) {
          runAutomaticCheck("Failed to check for updates:");
        }
        scheduleBackgroundChecks();
      }

      return preferences;
    },
  );

  ipcMain.handle("updater:check", async (): Promise<ManualUpdateCheckResult> => {
    try {
      const result = (await checkForUpdatesOnce()) as
        | { updateInfo: { version: string }; isUpdateAvailable?: boolean }
        | null;
      const currentVersion = app.getVersion();
      // Trust electron-updater's own decision rather than re-deriving it from
      // a version-string compare. The two diverge for pre-release channels,
      // staged rollouts, downgrades, and minimum-system-version gates — in
      // those cases updateInfo.version differs from app.getVersion() but no
      // `update-available` event fires, so showing "available" here would
      // promise a download prompt that never appears.
      return {
        ok: true,
        currentVersion,
        latestVersion: result?.updateInfo.version ?? currentVersion,
        available: result?.isUpdateAvailable ?? false,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Initial check shortly after startup so we don't block boot, plus a
  // background poll for long-running sessions. Both are torn down when the
  // user disables automatic updates and re-armed when they turn them back on.
  scheduleBackgroundChecks();
}
