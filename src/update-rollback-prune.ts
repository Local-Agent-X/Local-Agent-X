// Pruning of the superseded rollback archives under
// <data dir>/update-rollback-superseded/<tag>: the journals and backups the
// server (update-rollback.ts) or the desktop's pre-boot heal moved aside.
// Nothing removed them, so every heal and every reinstall left another copy of
// the files an update touched. UpdateRollbackTransaction.pruneSupersededArchives
// calls this once a boot has found the install known good, and never while a
// journal is active.

import { lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ROLLBACK_SUPERSEDED_DIR } from "./desktop-contract/data-dir.js";
import { safePathChain } from "./update-rollback-state.js";
import { createLogger } from "./logger.js";

const logger = createLogger("update-rollback");

/** An archive older than this is removed, unless it is one of the newest. */
export const SUPERSEDED_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Always kept, whatever their age: the two most recent archives. */
export const SUPERSEDED_ARCHIVES_KEPT = 2;

/** Remove the superseded rollback archives older than 30 days, keeping the
 *  newest two regardless. Age is the archive's last change (its journal's
 *  last write). Returns the tags removed; each removal is path-guarded so a
 *  linked or escaping entry is skipped, never followed. */
export async function pruneSupersededRollbackArchives(stateRoot: string, now: number = Date.now()): Promise<string[]> {
  if (!safePathChain(stateRoot, ROLLBACK_SUPERSEDED_DIR)) {
    throw new Error(`Update rollback archive path became linked or escaped: ${ROLLBACK_SUPERSEDED_DIR}`);
  }
  const root = join(stateRoot, ROLLBACK_SUPERSEDED_DIR);
  let tags: string[];
  try { tags = readdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const archives: Array<{ tag: string; changedAt: number }> = [];
  for (const tag of tags) {
    const rel = join(ROLLBACK_SUPERSEDED_DIR, tag);
    if (!safePathChain(stateRoot, rel)) continue;
    const info = lstatSync(join(stateRoot, rel));
    if (info.isDirectory()) archives.push({ tag, changedAt: info.mtimeMs });
  }
  archives.sort((left, right) => right.changedAt - left.changedAt);
  const removed: string[] = [];
  for (const { tag, changedAt } of archives.slice(SUPERSEDED_ARCHIVES_KEPT)) {
    if (now - changedAt <= SUPERSEDED_ARCHIVE_MAX_AGE_MS) continue;
    await rm(join(root, tag), { recursive: true, force: true });
    removed.push(tag);
  }
  if (removed.length > 0) {
    logger.info(`pruned ${removed.length} superseded rollback archive(s) older than 30 days: ${removed.join(", ")}`);
  }
  return removed;
}
