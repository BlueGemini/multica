// Pure orchestration for "stop the bundled daemon before the Windows
// installer runs". Kept free of Electron / fs / HTTP so it can be unit-tested
// with fakes; daemon-manager wires the real probes in.
//
// Why this exists: on Windows the running daemon holds a lock on the bundled
// `multica.exe`. The NSIS installer can only replace it if it manages to kill
// the daemon itself, which depends on PowerShell/CIM being usable. When it
// cannot, the installer's "Retry" path extracts while ignoring errors and the
// old daemon binary silently survives the update (GitHub #8823). Stopping the
// daemon from the app before handing off to the installer removes that
// dependency.

export type DaemonInstallPrep =
  /** No managed daemon is holding the binary (never ran, stopped, external). */
  | { kind: "ready" }
  /** The daemon is executing tasks and the caller did not allow interrupting. */
  | { kind: "busy"; activeTasks: number }
  /**
   * The daemon was asked to stop but did not exit before the deadline. The
   * caller should still install: the installer then behaves exactly as it did
   * before this gate existed, so the worst case is unchanged.
   */
  | { kind: "timeout" };

export interface DaemonInstallProbe {
  /** /health reports running or starting. */
  alive: boolean;
  pid?: number;
  activeTasks: number;
  /** Daemon runs somewhere we cannot drive (e.g. WSL2); it holds no lock on our binary. */
  externallyManaged: boolean;
}

export interface DaemonInstallGateDeps {
  /** Returns null when there is no managed daemon profile to probe. */
  probe: () => Promise<DaemonInstallProbe | null>;
  /** Requests a graceful stop. May resolve before the process has exited. */
  stop: () => Promise<void>;
  processExists: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface DaemonInstallGateOptions {
  interruptActiveTasks: boolean;
  /** Upper bound on waiting for the process to exit after the stop request. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export const DEFAULT_INSTALL_GATE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Makes sure the bundled daemon is no longer running before an install.
 *
 * `/health` disappearing is not enough: `multica daemon stop` returns success
 * after ~5s even when the process is still draining, and the file lock only
 * goes away once the process itself has exited. So we wait for both health and
 * the original PID to be gone.
 */
export async function prepareDaemonForInstall(
  deps: DaemonInstallGateDeps,
  options: DaemonInstallGateOptions,
): Promise<DaemonInstallPrep> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_GATE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const initial = await deps.probe();
  if (!initial || !initial.alive || initial.externallyManaged) {
    return { kind: "ready" };
  }
  if (!options.interruptActiveTasks && initial.activeTasks > 0) {
    return { kind: "busy", activeTasks: initial.activeTasks };
  }

  const pid = initial.pid;
  const deadline = deps.now() + timeoutMs;
  try {
    // Bound the stop itself: it queues behind any in-flight lifecycle op
    // (a start can take up to a minute), and the deadline must cover that.
    await Promise.race([deps.stop(), deps.sleep(timeoutMs)]);
  } catch (err) {
    // Fall through to the wait loop: the stop may still have landed, and if it
    // did not we time out into the pre-existing installer behaviour.
    console.warn("[updater] daemon stop before install failed:", err);
  }

  for (;;) {
    const current = await deps.probe();
    const healthGone = !current || !current.alive;
    const processGone = pid === undefined || !deps.processExists(pid);
    if (healthGone && processGone) return { kind: "ready" };
    if (deps.now() >= deadline) return { kind: "timeout" };
    await deps.sleep(pollIntervalMs);
  }
}
