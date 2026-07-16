/**
 * LM Studio server auto-start.
 *
 * The trap this closes: LM Studio's own chat UI works with its API server
 * OFF (the GUI talks to its engine over internal ephemeral ports), so a
 * user sees their models inside LM Studio while LAX's discovery sweep
 * finds nothing on :1234 — and gets no hint why. When a sweep comes back
 * with no LM Studio runtime AND the LM Studio app is already running AND
 * its bundled `lms` CLI exists, LAX flips the server on itself
 * (`lms server start` — the exact action of the Developer-tab toggle,
 * loopback-only) and the caller re-sweeps once so the models appear.
 *
 * Etiquette gates, in order:
 *   - never launches LM Studio itself — the app must already be running
 *     (the user's intent to use it is theirs, not ours);
 *   - attempts are throttled to one per ATTEMPT_INTERVAL_MS so a broken
 *     CLI isn't hammered every 60s sweep;
 *   - the flip is surfaced: a log line + lmStudioAutoStartedAt() for the
 *     local-runtimes API payload (no toast channel exists in this UI).
 *
 * Under vitest the default-deps path is inert (same rationale as the
 * discovery sweep's guard): tests exercise the logic via injected deps.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import type { LocalRuntimeInfo } from "./types.js";

const logger = createLogger("local-runtimes");
const execFileAsync = promisify(execFile);

/** Min gap between attempts — a failing CLI must not be hammered per-sweep. */
const ATTEMPT_INTERVAL_MS = 5 * 60_000;
/** `lms server start` normally returns in <1s; this is a hang backstop. */
const START_TIMEOUT_MS = 15_000;

/** Injectable seams for tests — real implementations touch processes. */
export interface LmStudioAutostartDeps {
  /** Is the LM Studio APP running (its GUI/service, not the API server)? */
  isLmStudioRunning(): Promise<boolean>;
  /** Absolute path to the bundled `lms` CLI, or null when not installed. */
  lmsCliPath(): string | null;
  /** Run `lms server start`. Resolves false on failure, never throws. */
  startServer(cliPath: string): Promise<boolean>;
}

function realLmsCliPath(): string | null {
  const p = path.join(
    os.homedir(),
    ".lmstudio",
    "bin",
    process.platform === "win32" ? "lms.exe" : "lms",
  );
  return existsSync(p) ? p : null;
}

async function realIsLmStudioRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", "IMAGENAME eq LM Studio.exe", "/FO", "CSV", "/NH"],
        { timeout: 10_000, windowsHide: true },
      );
      return stdout.includes("LM Studio.exe");
    }
    // pgrep exits non-zero (throws) when nothing matches.
    await execFileAsync("pgrep", ["-f", "LM Studio"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function realStartServer(cliPath: string): Promise<boolean> {
  try {
    await execFileAsync(cliPath, ["server", "start"], {
      timeout: START_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch (e) {
    logger.warn(`lms server start failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

const realDeps: LmStudioAutostartDeps = {
  isLmStudioRunning: realIsLmStudioRunning,
  lmsCliPath: realLmsCliPath,
  startServer: realStartServer,
};

let lastAttemptAt = 0;
let startedAt: number | null = null;

/**
 * When LAX auto-started LM Studio's server (epoch ms), or null if it never
 * has this process lifetime. Surfaced on the /api/local-runtimes payload
 * so the settings UI can label the runtime "started by LAX".
 */
export function lmStudioAutoStartedAt(): number | null {
  return startedAt;
}

/** Test seam: reset throttle + started state. */
export function resetLmStudioAutostart(): void {
  lastAttemptAt = 0;
  startedAt = null;
}

/**
 * Flip LM Studio's API server on when the sweep missed it but the app is
 * running. Returns true when the server was started (caller should
 * re-sweep once). Never throws.
 */
export async function maybeAutostartLmStudio(
  runtimes: readonly LocalRuntimeInfo[],
  deps?: LmStudioAutostartDeps,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!deps) {
    // Real-deps path spawns processes — inert under the test runner,
    // mirroring the discovery sweep's guard. Tests inject deps.
    if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
    deps = realDeps;
  }
  // Already discovered (identify() labels the endpoint) — nothing to do.
  if (runtimes.some((r) => r.label === "LM Studio")) return false;
  if (now() - lastAttemptAt < ATTEMPT_INTERVAL_MS) return false;
  lastAttemptAt = now();

  const cli = deps.lmsCliPath();
  if (!cli) return false;
  if (!(await deps.isLmStudioRunning())) return false;

  const ok = await deps.startServer(cli);
  if (ok) {
    startedAt = now();
    logger.info("LM Studio was running with its API server off — enabled it via `lms server start`");
  }
  return ok;
}
