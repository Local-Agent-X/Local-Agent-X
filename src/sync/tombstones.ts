import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { createLogger } from "../logger.js";
import { workspacePath } from "../config.js";

const logger = createLogger("sync.tombstones");

// ── Tombstones — explicit deletion intent across machines ──
//
// The bug we replaced: comparing local-vs-remote can't distinguish
// "deleted on remote" from "never existed on remote." Both look like
// "missing from remote." That meant any app present on machine A but
// never on machine B would get deleted from A as soon as B pushed, then
// propagated to all machines on pull.
//
// The fix: every machine maintains a snapshot of which workspace/apps
// existed at its last push (~/.lax/sync-state/last-pushed-apps.json).
// On the next push, anything in last-snapshot but missing now = "I
// intentionally deleted this since last push" → write a tombstone file
// into sync-repo/.tombstones/<name>.json. Tombstones are git-tracked so
// they propagate to all machines via the existing sync-repo git push/pull.
// On pull, every tombstone in remote → ensure local doesn't have that app.
// Local-only apps (never in last-snapshot, never tombstoned) survive.
//
// First-run safety: if the snapshot doesn't exist yet, we initialize it
// with the current set of apps and write zero tombstones — so a brand
// new machine doesn't retroactively tombstone every app the user has.

export interface TombstonePaths {
  snapshotFile: string;
  tombstonesDir: string;
  appsDir: string;
}

export function tombstonePaths(dataDir: string, syncDir: string): TombstonePaths {
  return {
    snapshotFile: join(dataDir, "sync-state", "last-pushed-apps.json"),
    tombstonesDir: join(syncDir, ".tombstones"),
    appsDir: workspacePath("apps"),
  };
}

/** Top-level subdirectories of workspace/apps — these are the units we tombstone. */
function listWorkspaceApps(appsDir: string): string[] {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir).filter(e => {
    try { return statSync(join(appsDir, e)).isDirectory(); } catch { return false; }
  });
}

/**
 * Pre-push: detect apps deleted on this machine since the last push,
 * write tombstones for them into sync-repo/.tombstones/, update the
 * per-machine snapshot. Idempotent — re-running doesn't re-tombstone.
 *
 * Also handles two edge cases that bite without explicit care:
 *   1. Resurrection: an app deleted last cycle and recreated this cycle
 *      keeps getting deleted on every pull because the old tombstone
 *      lingers. We clear the stale tombstone before writing new ones.
 *   2. Sync-repo bloat: additive-only push leaves dead app trees in
 *      sync-repo/workspace/apps/ forever. We prune the tree of any app
 *      we just tombstoned in the same step.
 */
export function writeTombstonesForDeletedApps(paths: TombstonePaths, syncDir: string): void {
  const { snapshotFile, tombstonesDir, appsDir } = paths;
  const current = new Set(listWorkspaceApps(appsDir));
  let last: string[] = [];
  let snapshotExisted = false;
  if (existsSync(snapshotFile)) {
    snapshotExisted = true;
    try { last = JSON.parse(readFileSync(snapshotFile, "utf-8")); } catch { last = []; }
  }
  if (!snapshotExisted) {
    // First run on this machine — DO NOT tombstone everything not in snapshot.
    // Just initialize snapshot to current state. Future pushes will detect
    // real deletions vs. this baseline.
    mkdirSync(dirname(snapshotFile), { recursive: true });
    writeFileSync(snapshotFile, JSON.stringify([...current].sort(), null, 2));
    logger.info(`[sync] tombstone snapshot initialized (${current.size} apps baseline)`);
    return;
  }

  // Resurrection: clear any tombstone for an app that exists locally again.
  // Without this, the old tombstone keeps deleting the recreated app on
  // every pull anywhere in the fleet.
  if (existsSync(tombstonesDir)) {
    for (const file of readdirSync(tombstonesDir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      if (current.has(name)) {
        try {
          unlinkSync(join(tombstonesDir, file));
          logger.info(`[sync] tombstone cleared — "${name}" exists again locally`);
        } catch (e) {
          logger.warn(`[sync] failed to clear tombstone for ${name}: ${(e as Error).message}`);
        }
      }
    }
  }

  const deletedSinceLast = last.filter(name => !current.has(name));
  if (deletedSinceLast.length > 0) {
    if (!existsSync(tombstonesDir)) mkdirSync(tombstonesDir, { recursive: true });
    for (const name of deletedSinceLast) {
      const tombstone = { name, deletedAt: new Date().toISOString(), deletedBy: hostname() };
      writeFileSync(join(tombstonesDir, `${name}.json`), JSON.stringify(tombstone, null, 2));
      logger.info(`[sync] tombstone written for "${name}" (deleted on ${tombstone.deletedBy})`);
      // Prune the dead app tree from sync-repo so it doesn't accumulate.
      // additiveOnly mirroring leaves these behind otherwise.
      const syncAppDir = join(syncDir, "workspace", "apps", name);
      if (existsSync(syncAppDir)) {
        try { rmSync(syncAppDir, { recursive: true, force: true }); }
        catch (e) { logger.warn(`[sync] failed to prune sync-repo/${name}: ${(e as Error).message}`); }
      }
    }
  }
  // Update snapshot to current state
  writeFileSync(snapshotFile, JSON.stringify([...current].sort(), null, 2));
}

/**
 * Eager tombstone — called the moment a workspace app folder is
 * deleted via the API/UI, NOT at push time. Why: without this, the
 * sequence "user deletes folder → server restart before push → pull
 * from remote re-creates folder (remote still has it)" caused the
 * folder to reappear on next boot. Writing the tombstone here means
 * even a restart-before-push survives the round-trip — applyTombstones
 * during the next pull reads this tombstone and re-deletes the local
 * copy that just got resurrected by pullDir(additiveOnly).
 *
 * Idempotent. Writes only to the synced store (sync-repo/.tombstones).
 * The push-time diff in writeTombstonesForDeletedApps will harmlessly
 * re-overwrite this same file on the next push — same content, no new
 * git churn. The snapshot file is left alone so push-time diff still
 * sees the name as "deleted since last push" and prunes the synced
 * workspace/apps/<name> tree (eager doesn't prune; only push does).
 */
export function tombstoneAppEagerly(syncDir: string, name: string): void {
  const tombstonesDir = join(syncDir, ".tombstones");
  if (!existsSync(tombstonesDir)) mkdirSync(tombstonesDir, { recursive: true });
  const tombstone = { name, deletedAt: new Date().toISOString(), deletedBy: hostname() };
  writeFileSync(join(tombstonesDir, `${name}.json`), JSON.stringify(tombstone, null, 2));
  logger.info(`[sync] eager tombstone written for "${name}"`);
}

/**
 * Post-pull: read tombstones in sync-repo and ensure local doesn't have
 * any tombstoned apps. Idempotent — apps already absent locally are skipped.
 */
export function applyTombstones(paths: TombstonePaths): void {
  const { tombstonesDir, appsDir } = paths;
  if (!existsSync(tombstonesDir)) return;
  if (!existsSync(appsDir)) return;
  for (const file of readdirSync(tombstonesDir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const localApp = join(appsDir, name);
    if (existsSync(localApp)) {
      logger.info(`[sync] tombstone — removing local "${name}"`);
      try { rmSync(localApp, { recursive: true, force: true }); } catch (e) {
        logger.warn(`[sync] tombstone removal failed for ${name}: ${(e as Error).message}`);
      }
    }
  }
}
