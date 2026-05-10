import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { createLogger } from "../logger.js";
import { MAX_FILE_SIZE, SKIP_DIRS, SYNC_EXTENSIONS } from "./constants.js";

const logger = createLogger("sync.mirror");

/**
 * Mirror src → dest: copies files. When `additiveOnly` is true, dest entries
 * not in src are LEFT IN PLACE — caller is responsible for tombstone-driven
 * deletion. When false (legacy default), dest entries not in src are removed.
 *
 * The workspace push path (push() → mirrorDir(workspace, …)) MUST pass
 * additiveOnly=true. Otherwise A pushing its workspace deletes B's
 * machine-only apps from sync-repo, which then propagates to all machines
 * on next pull. That's the bug the tombstone system replaces.
 */
export function mirrorDir(src: string, dest: string, additiveOnly = false): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const srcEntries = new Set<string>();

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) { srcEntries.add(entry); mirrorDir(srcPath, join(dest, entry), additiveOnly); }
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      const isDoc = /^(PROJECT|CHANGELOG|TODO|README)\.md$/i.test(entry);
      if ((SYNC_EXTENSIONS.has(ext) || isDoc) && stat.size <= MAX_FILE_SIZE) {
        srcEntries.add(entry);
        writeFileSync(join(dest, entry), readFileSync(srcPath));
      }
    }
  }
  if (!additiveOnly) {
    // Legacy destructive behavior — only safe for caller-controlled trees
    // where remote-state really IS authoritative. NOT safe for workspace.
    for (const entry of readdirSync(dest)) {
      if (!srcEntries.has(entry)) {
        const p = join(dest, entry);
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
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
    remoteEntries.add(entry);
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      pullDir(srcPath, destPath, additiveOnly);
    } else if (stat.isFile()) {
      if (!existsSync(destPath) || statSync(destPath).mtimeMs < stat.mtimeMs) writeFileSync(destPath, readFileSync(srcPath));
    }
  }
  if (!additiveOnly) {
    // Legacy: delete local entries removed from sync repo. NOT used for
    // workspace anymore (see applyTombstones).
    for (const entry of readdirSync(dest)) {
      if (!remoteEntries.has(entry)) {
        const p = join(dest, entry);
        logger.info(`[sync] Deleting ${relative(resolve("workspace"), p)} (removed from remote)`);
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
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
