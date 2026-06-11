import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";

const logger = createLogger("safe-delete");
const RETENTION_DAYS = 30;

// Recoverable delete for USER data. Destructive ops on the workspace
// (delete_file, app_delete, project-roster delete) route here instead of
// unlink/rmSync so a mistake can be undone. Build artifacts, caches and temp
// dirs still hard-delete; only user data routes through here.
//
// Two tiers:
//   1. The real OS Trash / Recycle Bin (macOS Finder, Windows Recycle Bin,
//      Linux gio trash) — discoverable: the user browses, restores ("Put
//      Back") and empties it the normal way, no hidden folder.
//   2. Fallback to ~/.lax/trash/<YYYY-MM-DD>/ when the OS trash isn't reachable
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
export function moveToTrash(path: string, reason?: string): string | null {
  if (!existsSync(path)) return null;
  const tag = reason ? ` (${reason})` : "";

  if (nativeTrash(path)) {
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
function nativeTrash(path: string): boolean {
  if (process.env.LAX_NO_NATIVE_TRASH) return false;
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
