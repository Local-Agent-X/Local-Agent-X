import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

import { createLogger } from "../logger.js";
import { MAX_FILE_SIZE, SKIP_DIRS, SYNC_EXTENSIONS } from "./constants.js";

const logger = createLogger("sync.mirror");

// Git for Windows refuses paths past ~260 chars ("Filename too long"), so any
// entry the mirror writes deeper than this would wedge every later git
// add/status in sync-repo. Skip-and-warn instead of copying a path git can
// never read back. 240 leaves headroom for .git/objects bookkeeping.
const MAX_DEST_PATH = 240;

/**
 * Mirror src → dest: copies files. When `additiveOnly` is true, dest entries
 * not in src are LEFT IN PLACE — caller is responsible for tombstone-driven
 * deletion. When false (legacy default), dest entries not in src are removed.
 *
 * The workspace push path (push() → mirrorDir(workspace, …)) MUST pass
 * additiveOnly=true. Otherwise A pushing its workspace deletes B's
 * machine-only apps from sync-repo, which then propagates to all machines
 * on next pull. That's the bug the tombstone system replaces.
 *
 * Async on purpose: the old synchronous readdirSync/readFileSync/writeFileSync
 * recursion walked the ENTIRE workspace on the event-loop thread inside every
 * push(). A heartbeat firing mid-turn stalled all HTTP/streaming for the
 * copy's duration (seconds on a large workspace). Using fs/promises yields the
 * loop between every stat/read/write, so requests are serviced during the copy.
 */
export async function mirrorDir(src: string, dest: string, additiveOnly = false): Promise<void> {
  await mkdir(dest, { recursive: true });
  const srcEntries = new Set<string>();

  for (const entry of await readdir(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    // lstat, not stat: a symlink must never be followed. pnpm stores and
    // container-extracted trees carry links pointing back up the tree; a
    // followed loop materializes as endless real directories in dest.
    const st = await lstat(srcPath);
    if (st.isSymbolicLink()) continue;
    if (destPath.length > MAX_DEST_PATH) {
      logger.warn(`[sync] skipping ${srcPath}: dest path ${destPath.length} chars exceeds git-safe limit ${MAX_DEST_PATH}`);
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) { srcEntries.add(entry); await mirrorDir(srcPath, destPath, additiveOnly); }
    } else if (st.isFile()) {
      const ext = extname(entry).toLowerCase();
      const isDoc = /^(PROJECT|CHANGELOG|TODO|README)\.md$/i.test(entry);
      if ((SYNC_EXTENSIONS.has(ext) || isDoc) && st.size <= MAX_FILE_SIZE) {
        srcEntries.add(entry);
        await writeFile(destPath, await readFile(srcPath));
      }
    }
  }
  if (!additiveOnly) {
    // Legacy destructive behavior — only safe for caller-controlled trees
    // where remote-state really IS authoritative. NOT safe for workspace.
    for (const entry of await readdir(dest)) {
      if (!srcEntries.has(entry)) {
        const p = join(dest, entry);
        if ((await stat(p)).isDirectory()) await rm(p, { recursive: true, force: true }); else await unlink(p);
      }
    }
  }
}

/**
 * Pull from sync → local.
 *
 * When `additiveOnly` is true, local entries missing from src are LEFT
 * ALONE — caller applies tombstones explicitly to drive deletions. When
 * false (legacy), missing-from-remote propagates as a local delete (the
 * old buggy behavior — see writeTombstonesForDeletedApps for the fix).
 *
 * Used additively for workspace pulls; legacy/destructive for older
 * pull paths that still rely on it (none currently — kept for safety).
 */
export function pullDir(src: string, dest: string, additiveOnly = false): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const remoteEntries = new Set<string>();
  for (const entry of readdirSync(src)) {
    // Present-in-remote is recorded even for entries the guards below skip:
    // a skipped entry must read as "exists remotely, not copied", never as
    // "deleted remotely" (legacy destructive mode deletes on that signal).
    remoteEntries.add(entry);
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    // Same guards as mirrorDir: never follow symlinks, never write past the
    // git-safe path limit, never import tooling state (a sync-repo poisoned
    // by a machine running pre-guard code must not propagate junk here).
    const stat = lstatSync(srcPath);
    if (stat.isSymbolicLink()) continue;
    if (destPath.length > MAX_DEST_PATH) {
      logger.warn(`[sync] skipping pull of ${srcPath}: dest path ${destPath.length} chars exceeds git-safe limit ${MAX_DEST_PATH}`);
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) pullDir(srcPath, destPath, additiveOnly);
    } else if (stat.isFile()) {
      if (!existsSync(destPath) || lstatSync(destPath).mtimeMs < stat.mtimeMs) writeFileSync(destPath, readFileSync(srcPath));
    }
  }
  if (!additiveOnly) {
    // Legacy: delete local entries removed from sync repo. NOT used for
    // workspace anymore (see applyTombstones).
    for (const entry of readdirSync(dest)) {
      if (!remoteEntries.has(entry)) {
        const p = join(dest, entry);
        logger.info(`[sync] Deleting ${relative(resolve("workspace"), p)} (removed from remote)`);
        if (lstatSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
      }
    }
  }
}

export function unionMerge(local: string, remote: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const line of local.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (!seen.has(line)) { seen.add(line); merged.push(line); }
  }
  for (const line of remote.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (!seen.has(line)) { seen.add(line); merged.push(line); }
  }
  return merged.join("\n") + "\n";
}
