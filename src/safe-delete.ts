import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";

const logger = createLogger("safe-delete");
const RETENTION_DAYS = 30;

// App-managed recycle bin for USER data. Destructive ops on the workspace
// (delete_file, app_delete) move here instead of unlink/rmSync so a mistake is
// recoverable — the same safety posture as the snapshot/backup dirs already
// under ~/.lax. Build artifacts, caches and temp dirs still hard-delete; only
// user data routes through here. Restore = move an entry back out of
// ~/.lax/trash/<YYYY-MM-DD>/.
//
// NOT the OS Finder/Recycle Bin: the server process has no Electron shell, and
// a native trash dependency isn't worth the supply-chain surface for a
// recoverable-delete net. (2026-06-10: a misdirected workspace migration
// perma-deleted the user's apps; only the ~/.lax snapshots saved them. This
// makes the next such slip recoverable from the trash too.)

function trashRoot(): string {
  return join(getLaxDir(), "trash");
}

/** Move a file or directory into the app recycle bin. Returns the trash path,
 *  or null if the source didn't exist. `reason` is logged, not stored. */
export function moveToTrash(path: string, reason?: string): string | null {
  if (!existsSync(path)) return null;
  const now = new Date();
  const dir = join(trashRoot(), now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(path)}.${now.getTime()}`);
  try {
    renameSync(path, dest);
  } catch {
    // Cross-device rename (workspace on another volume) — copy then remove.
    cpSync(path, dest, { recursive: true });
    rmSync(path, { recursive: true, force: true });
  }
  logger.info(`[trash] ${path} -> ${dest}${reason ? ` (${reason})` : ""}`);
  sweepOldTrash();
  return dest;
}

// Purge trash day-folders older than the retention window. Best-effort: the
// only hard-delete in this module, and it never touches anything outside
// ~/.lax/trash, so a failure here can't endanger user data.
function sweepOldTrash(): void {
  try {
    const root = trashRoot();
    if (!existsSync(root)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const day of readdirSync(root)) {
      const t = Date.parse(day);
      if (!Number.isNaN(t) && t < cutoff) rmSync(join(root, day), { recursive: true, force: true });
    }
  } catch { /* retention is best-effort; never break a delete */ }
}
