import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, normalize } from "node:path";
import { promisify } from "node:util";

import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("browser.cleanup-stale");

/**
 * Kill orphan Chrome processes from a previous server lifetime that still
 * hold the agent's user-data-dir, and remove the Singleton lock files
 * Chrome leaves behind on hard exits.
 *
 * Why this exists: after a server restart, Chrome processes spawned by
 * the previous run sometimes survive (especially if SIGINT shutdown
 * timed out, or PowerShell Stop-Process didn't cascade to all helper
 * processes). They keep the SingletonLock file held, and the next
 * `launchViaCDP` call either silently joins the dead instance (no
 * visible window — the bug the user hit) or fails to launch.
 *
 * SAFETY: only kills processes whose `--user-data-dir` matches the
 * agent's profile EXACTLY. Never touches the user's regular Chrome.
 */
export async function cleanupStaleAgentChrome(userDataDir: string): Promise<void> {
  const targetDir = normalize(userDataDir);
  logger.info(`[browser-cleanup] scanning for stale Chrome processes on ${targetDir}`);

  try {
    const killed = await killProcessesUsingProfile(targetDir);
    if (killed.length > 0) {
      logger.info(`[browser-cleanup] killed ${killed.length} stale Chrome process(es): PIDs ${killed.join(", ")}`);
      // Give the OS a moment to release file handles before unlinking
      // Singleton* — premature unlink can race with the kill's file-handle
      // teardown on Windows and throw EBUSY.
      await new Promise(r => setTimeout(r, 250));
    } else {
      logger.info(`[browser-cleanup] no stale processes found`);
    }
  } catch (e) {
    logger.warn(`[browser-cleanup] process scan failed (non-fatal): ${(e as Error).message}`);
  }

  // Remove Singleton* sentinel files. Chrome creates these on launch and
  // removes them on clean shutdown. A crash or kill leaves them behind,
  // and the next Chrome launch interprets them as "another instance
  // owns this profile" → no window.
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const path = join(targetDir, name);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        logger.info(`[browser-cleanup] Removed stale ${name}`);
      } catch (e) {
        logger.warn(`[browser-cleanup] Failed to remove ${name}: ${(e as Error).message}`);
      }
    }
  }
}

/**
 * Find and kill every Chrome/Edge process whose CommandLine contains
 * `--user-data-dir=<targetDir>`. Returns the killed PIDs.
 *
 * Windows: WMIC is deprecated on newer Windows; we use PowerShell's
 * Get-CimInstance instead, which is the supported replacement and
 * doesn't trip the "WMIC is not recognized" failure on stripped images.
 *
 * Unix: ps + grep + kill.
 */
async function killProcessesUsingProfile(targetDir: string): Promise<number[]> {
  const killed: number[] = [];

  if (process.platform === "win32") {
    // PowerShell one-liner: list chrome.exe processes, filter by CommandLine
    // containing the target user-data-dir (case-insensitive), emit PIDs.
    // -ErrorAction SilentlyContinue swallows the empty case cleanly.
    const escaped = targetDir.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" ` +
      `-ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${escaped.toLowerCase()}') } | ` +
      `Select-Object -ExpandProperty ProcessId`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10_000, windowsHide: true },
    );
    const pids = stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => /^\d+$/.test(s))
      .map(s => parseInt(s, 10));

    for (const pid of pids) {
      try {
        process.kill(pid);
        killed.push(pid);
      } catch {
        // Process may have exited between detection and kill — fine.
      }
    }
    return killed;
  }

  // Unix path. `pgrep -f` matches CommandLine substring. -d to print
  // PIDs newline-separated.
  try {
    const { stdout } = await execFileAsync(
      "pgrep",
      ["-f", `--user-data-dir=${targetDir}`],
      { timeout: 5_000 },
    );
    const pids = stdout.split(/\s+/).filter(s => /^\d+$/.test(s)).map(s => parseInt(s, 10));
    for (const pid of pids) {
      try { process.kill(pid); killed.push(pid); } catch { /* gone */ }
    }
  } catch {
    // pgrep exits non-zero on no-match — that's the common case.
  }
  return killed;
}
