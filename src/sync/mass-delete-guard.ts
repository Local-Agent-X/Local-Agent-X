import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";

const logger = createLogger("sync.mass-delete-guard");

// Mass-deletion circuit breaker. Live failure (2026-05-05): a sync push
// deleted 21 workspace apps belonging to other machines, despite the
// additive-only mirror + tombstone system. Root cause unconfirmed (likely
// stale local sync-repo + rebase artifact), but the FIX is defense-in-depth:
// refuse any push whose workspace/apps mass-deletes top-level apps that aren't
// paired with explicit tombstones. Forces the user to investigate before
// destructive sync changes propagate. Recovery from origin is one git
// checkout; an unintended push is permanent and propagates everywhere on the
// next pull.

/** Untombstoned app deletions at or above this count abort the push. */
export const ABORT_THRESHOLD = 3;

/** Top-level app directories with at least one file staged for deletion. */
function deletedAppDirs(porcelain: string): Set<string> {
  const names = new Set<string>();
  for (const line of porcelain.split("\n")) {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) continue;
    if (!status.includes("D")) continue;
    const m = path.match(/^workspace\/apps\/([^/]+)\//);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Names with a tombstone present in the sync repo.
 *
 * Authorization is "a tombstone EXISTS", not "a tombstone was added in this
 * cycle" — so read the directory rather than scanning porcelain for A/?.
 *
 * The porcelain version wedged sync permanently (2026-07-28 live failure).
 * Deleting an app through the UI writes an eager tombstone
 * (tombstoneAppEagerly); the next cycle commits it, so it becomes tracked. A
 * LATER cycle's writeTombstonesForDeletedApps re-stamps that same tombstone
 * with a fresh deletedAt (staged M, not A) and only THEN prunes
 * workspace/apps/<name> (staged D). That pairing — D with an M tombstone — is
 * the normal UI-delete path, and it counted as unauthorized. Three such apps
 * and every subsequent sync aborted forever.
 *
 * Reading the dir also covers the tracked-and-unchanged case (D paired with a
 * tombstone that isn't in porcelain at all), and stays strict in the direction
 * that matters: a tombstone staged for deletion is gone from disk, so it
 * grants nothing.
 */
function tombstonedNames(syncDir: string): Set<string> {
  const names = new Set<string>();
  const dir = join(syncDir, ".tombstones");
  if (!existsSync(dir)) return names;
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) names.add(file.slice(0, -5));
    }
  } catch (e) {
    // Read failure means we can prove nothing — authorize nothing, so a
    // real mass-delete still trips the breaker.
    logger.warn(`[sync] could not read tombstones dir: ${(e as Error).message}`);
  }
  return names;
}

/** Apps this push would delete without a tombstone authorizing it. */
export function findUnauthorizedAppDeletions(porcelain: string, syncDir: string): string[] {
  const authorized = tombstonedNames(syncDir);
  return [...deletedAppDirs(porcelain)].filter(name => !authorized.has(name));
}

/** The abort message shown in the UI, listing at most 10 offenders. */
export function massDeleteAbortMessage(unauthorized: string[]): string {
  const list = unauthorized.slice(0, 10).join(", ")
    + (unauthorized.length > 10 ? `, …+${unauthorized.length - 10} more` : "");
  return `[sync] ABORTED: push would mass-delete ${unauthorized.length} workspace apps with no matching tombstones (${list}). Likely a stale local sync-repo clone. Inspect ~/.lax/sync-repo (git status / git diff --cached), then manually reconcile (wipe and re-clone, or git pull origin main) before retrying.`;
}
