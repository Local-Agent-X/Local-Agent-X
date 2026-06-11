import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getLaxDir } from "./lax-data-dir.js";
import { desktopTrashItem } from "./desktop-bridge.js";
import { createLogger } from "./logger.js";

const logger = createLogger("safe-delete");
const RETENTION_DAYS = 30;

// Recoverable delete for USER data. Destructive ops on the workspace
// (delete_file, app_delete, project-roster delete) route here instead of
// unlink/rmSync so a mistake can be undone. Build artifacts, caches and temp
// dirs still hard-delete; only user data routes through here.
//
// Two tiers:
//   1. The real OS Trash / Recycle Bin — discoverable: the user browses,
//      restores and empties it the normal way, no hidden folder. Preferred
//      route is the Electron-main bridge (shell.trashItem), which records the
//      original location so macOS "Put Back" / Windows-Linux "Restore" work.
//      Standalone (no desktop) falls back to a direct move into the OS trash
//      dir — recoverable, but without Put Back metadata on macOS.
//   2. Fallback to ~/.lax/trash/<YYYY-MM-DD>/ when no OS trash is reachable
//      (headless server, no GUI session, missing `gio`) — the data is still
//      recoverable, just from a dotfolder.
//
// (2026-06-10: a misdirected workspace migration perma-deleted the user's apps;
// only the ~/.lax snapshots saved them. This makes the next such slip land in
// the recycle bin instead.)

function trashRoot(): string {
  return join(getLaxDir(), "trash");
}

/** Move a file or directory to the recycle bin. Returns a human-readable
 *  location (for surfacing to the user) or null if the source didn't exist. */
export async function moveToTrash(path: string, reason?: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const tag = reason ? ` (${reason})` : "";

  if (await nativeTrash(path)) {
    logger.info(`[trash] ${path} -> OS recycle bin${tag}`);
    return "the system Trash";
  }

  // Fallback: app-managed recycle bin under ~/.lax.
  const now = new Date();
  const dir = join(trashRoot(), now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(path)}.${now.getTime()}`);
  try {
    renameSync(path, dest);
  } catch {
    cpSync(path, dest, { recursive: true });
    rmSync(path, { recursive: true, force: true });
  }
  logger.info(`[trash] ${path} -> ${dest}${tag}`);
  sweepOldTrash();
  return dest;
}

// Move to the OS Trash / Recycle Bin via the platform's native facility. Best
// effort: returns true only when the item actually left `path`. Disabled under
// the test harness so suites never touch the developer's real Trash.
async function nativeTrash(path: string): Promise<boolean> {
  if (process.env.LAX_NO_NATIVE_TRASH) return false;
  // Preferred: ask Electron main to use shell.trashItem (real Put Back /
  // Restore). Absent outside the desktop app — then fall through to the
  // platform's own facility below.
  if (await desktopTrashItem(path)) return true;
  try {
    if (process.platform === "darwin") {
      // Direct move into ~/.Trash. macOS TCC blocks driving Finder via
      // osascript from a CLI/server process (Automation prompt), but WRITING
      // into ~/.Trash is an ordinary filesystem op — the item shows up in the
      // user's Trash, browsable and emptyable. (No Finder "Put Back" metadata;
      // the user drags it out or Empty-Trashes it.) Timestamp suffix avoids
      // clobbering an existing same-named item — the Trash listing is itself
      // TCC-protected, so we can't check for collisions, only avoid them.
      renameSync(path, join(homedir(), ".Trash", `${basename(path)}.${Date.now()}`));
    } else if (process.platform === "win32") {
      const p = path.replace(/'/g, "''");
      execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
          `if (Test-Path -PathType Container '${p}') { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${p}','OnlyErrorDialogs','SendToRecycleBin') } ` +
          `else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${p}','OnlyErrorDialogs','SendToRecycleBin') }`],
        { stdio: "ignore", timeout: 10_000 },
      );
    } else {
      execFileSync("gio", ["trash", "--", path], { stdio: "ignore", timeout: 10_000 });
    }
    return !existsSync(path);
  } catch {
    return false; // no GUI session / tool missing / permission — caller falls back to ~/.lax/trash
  }
}

/** Snapshot a deleted CONFIG record (a project container, an agent definition)
 *  as JSON so the deletion is recoverable. Metadata goes to ~/.lax/trash, not
 *  the OS Trash — a cryptic `project-….json` in Finder isn't something a user
 *  can "Put Back". Best-effort: never throws into the caller's delete path. */
export function trashRecord(name: string, data: unknown): void {
  try {
    const now = new Date();
    const dir = join(trashRoot(), now.toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = join(dir, `${safe}.${now.getTime()}.json`);
    writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
    logger.info(`[trash] snapshot ${name} -> ${dest}`);
    sweepOldTrash();
  } catch (e) {
    logger.warn(`[trash] failed to snapshot ${name}: ${(e as Error).message}`);
  }
}

// Purge fallback trash day-folders older than the retention window. Best-effort:
// the only hard-delete here, and it never touches anything outside ~/.lax/trash.
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
