import { existsSync, unlinkSync } from "node:fs";
import { join, normalize } from "node:path";

import { createLogger } from "../logger.js";
import { findAndKillProcesses } from "../reap-stale-procs.js";

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
 * Find and kill every Chrome/Edge process whose CommandLine contains the
 * agent's `--user-data-dir`. Delegates to the shared command-line process
 * reaper (reap-stale-procs.ts). No age filter: agent Chrome is spawned
 * on-demand by browser tools, never at boot, so any match is from a prior
 * lifetime.
 */
async function killProcessesUsingProfile(targetDir: string): Promise<number[]> {
  return findAndKillProcesses({
    processNames: ["chrome.exe", "msedge.exe"],
    cmdlineContains: targetDir,
    label: "browser.cleanup-stale",
  });
}
