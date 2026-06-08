import {
  existsSync,
  statSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  renameSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("workspace.lifecycle");

// ── Workspace relocation + bridging ──
//
// The canonical home for "where does the agent workspace physically live, and
// how do we keep one source of truth as it moves." loadConfig() drives these at
// boot; the agent-facing path resolver (./paths.ts) consumes the result.

// Windows "Known Folder Move" redirects Documents into ...\OneDrive\Documents,
// and Electron's getPath("documents") faithfully returns that. A high-write
// agent workspace must NOT live under OneDrive: the sync client locks files
// mid-write, breaks our atomic config.json rename, and adds per-op latency.
// Map a OneDrive Documents path back to the real on-disk ~/Documents when that
// exists (a genuine relocation to another drive is left untouched).
// Pure transform: drop the "\OneDrive" segment sitting immediately before
// "\Documents", leaving the on-disk path. ...\OneDrive\Documents\X →
// ...\Documents\X. A path without that exact shape is returned unchanged.
// Exported for tests — the regex is the bug-prone part.
export function stripOneDriveDocuments(dir: string): string {
  if (!/[\\/]OneDrive[\\/]Documents([\\/]|$)/i.test(dir)) return dir;
  return dir.replace(/[\\/]OneDrive(?=[\\/]Documents)/i, "");
}

export function deOneDrive(dir: string): string {
  if (process.platform !== "win32") return dir;
  const stripped = stripOneDriveDocuments(dir);
  if (stripped === dir) return dir;
  // Only redirect if the real on-disk Documents actually exists, so a genuine
  // relocation to another drive is left untouched.
  if (!existsSync(join(homedir(), "Documents"))) return dir;
  return stripped;
}

// macOS analogue of the OneDrive guard. iCloud "Desktop & Documents Folders"
// sync (and third-party File Providers under ~/Library/CloudStorage) back the
// user's Documents with a sync engine that evicts idle files to dataless
// placeholders — a generated video then reads back as 0 bytes and renders as a
// blank player, and config.json's atomic rename can be locked mid-write. So the
// high-write agent workspace must stay on local-only disk. Unlike OneDrive KFM
// (a recognizable path segment), Apple firmlinks ~/Documents to the CloudDocs
// store WITHOUT changing the path string, so this is detected by identity
// (same device+inode as the canonical CloudDocs Documents), not by pattern.
const CLOUD_STORAGE_RE = /[\\/]Library[\\/](Mobile Documents[\\/]com~apple~CloudDocs|CloudStorage)[\\/]/i;

// Pure + exported for tests: is the path string itself under a known cloud
// provider mount? Catches third-party File Providers (Dropbox, Google Drive,
// OneDrive-for-Mac under ~/Library/CloudStorage) and an already-resolved iCloud
// path. The inode check below covers Apple's path-preserving Documents sync.
export function isCloudStoragePath(dir: string): boolean {
  return CLOUD_STORAGE_RE.test(dir);
}

// darwin-only: is `dir` backed by iCloud "Desktop & Documents" sync? The path
// string stays /Users/x/Documents, so compare device+inode against the
// canonical CloudDocs Documents directory. Returns false when that directory is
// absent (sync off) or on non-macOS.
export function isCloudSyncedDir(dir: string): boolean {
  if (process.platform !== "darwin") return false;
  if (isCloudStoragePath(dir)) return true;
  try {
    const target = statSync(dir);
    const cloudDocs = statSync(
      join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"),
    );
    return target.dev === cloudDocs.dev && target.ino === cloudDocs.ino;
  } catch {
    return false; // CloudDocs Documents missing → Desktop & Documents sync is off
  }
}

// Local-only workspace home for cloud-synced Macs. ~/.lax is a home dotfolder
// the iCloud Documents feature never touches, and already holds config/memory/
// logs — so the workspace sits beside its own data, off the sync engine. This
// trades the Finder-discoverability of the ~/Documents default for correctness,
// the same call the Windows guard makes by leaving OneDrive.
export function localOnlyWorkspace(): string {
  return join(getLaxDir(), "workspace");
}

// Ensure <cwd>/workspace and config.workspace are the SAME physical directory.
// They're only naturally equal in dev (workspace = "./workspace"); once the
// workspace is relocated (Documents), cwd-relative file tools and the
// config.workspace-based static server diverge. A directory junction (Windows)
// / symlink (POSIX) bridges them with zero per-tool path rewrites. Idempotent
// and non-destructive: a real cwd/workspace dir has its contents migrated into
// the target first, and is only removed once empty.
export function ensureWorkspaceLink(workspace: string): void {
  const target = resolve(workspace);
  const link = resolve("workspace");
  if (link === target) return; // dev default — already one directory
  // Already the same physical directory via a junction/symlink (in EITHER
  // direction — e.g. Documents\Local Agent X → repo\workspace)? realpathSync
  // resolves the link so we recognize it and skip, instead of trying to
  // migrate a directory onto itself.
  try {
    if (existsSync(link) && existsSync(target) && realpathSync(link) === realpathSync(target)) return;
  } catch { /* not resolvable yet — fall through to link creation */ }
  try {
    mkdirSync(target, { recursive: true });
    const st = existsSync(link) ? lstatSync(link) : null;
    if (st?.isSymbolicLink()) {
      if (resolve(readlinkSync(link)) === target) return; // already linked correctly
      unlinkSync(link); // points elsewhere — relink below
    } else if (st?.isDirectory()) {
      migrateWorkspace(link, target);
      if (readdirSync(link).length > 0) {
        logger.warn(`[config] ${link} still has files after migrate — leaving real dir, NOT junctioning (resolve manually)`);
        return;
      }
      rmSync(link, { recursive: true, force: true });
    } else if (st) {
      return; // a file named "workspace" — leave it, don't clobber
    }
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    logger.info(`[config] linked ${link} → ${target} (single workspace dir)`);
  } catch (e) {
    logger.warn(`[config] could not link workspace to ${target}: ${(e as Error).message}`);
  }
}

// Move files off the legacy install-dir workspace into the new Documents
// workspace. Per-entry and non-clobbering; falls back to copy+delete when a
// rename would cross devices. Best-effort — a failed entry is logged and
// skipped rather than aborting startup.
export function migrateWorkspace(oldWorkspace: string, newWorkspace: string): void {
  if (oldWorkspace === newWorkspace) return;
  mkdirSync(newWorkspace, { recursive: true });
  if (!existsSync(oldWorkspace)) return;
  let moved = 0;
  for (const entry of readdirSync(oldWorkspace)) {
    const from = join(oldWorkspace, entry);
    const to = join(newWorkspace, entry);
    if (existsSync(to)) {
      // Collision. If BOTH sides are directories, merge recursively instead of
      // skipping the whole subtree — otherwise a pre-created empty dir at the
      // destination (apps/images/videos/missions) strands the source's contents
      // and ensureWorkspaceLink then refuses to junction, leaving a split-brain
      // workspace (apps written to cwd, served from config.workspace). A
      // file-vs-anything collision is still left in place (never clobber).
      try {
        if (statSync(from).isDirectory() && statSync(to).isDirectory()) {
          migrateWorkspace(from, to);
          if (readdirSync(from).length === 0) rmSync(from, { recursive: true, force: true });
        }
      } catch (e) {
        logger.warn(`[config] workspace merge skipped "${entry}": ${(e as Error).message}`);
      }
      continue;
    }
    try {
      renameSync(from, to);
      moved++;
    } catch {
      try {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
        moved++;
      } catch (e) {
        logger.warn(`[config] workspace migrate skipped "${entry}": ${(e as Error).message}`);
      }
    }
  }
  if (moved) logger.info(`[config] migrated ${moved} workspace item(s): ${oldWorkspace} → ${newWorkspace}`);
}
