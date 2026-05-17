/**
 * Sidebar-pin tombstones — explicit "I unpinned this" intent that
 * survives a sync pull.
 *
 * Why this exists: the legacy pull-files.ts logic replaces the local
 * sidebar-pins array with the remote one. That clobbered any pin you
 * unpinned locally before pushing — the next pull from a machine that
 * still had the pin restored it. The same bug as the workspace/apps
 * tombstone story, in a different file shape.
 *
 * Two tombstone stores:
 *   - Local: `~/.lax/sync-state/pin-tombstones.json` — names you've
 *     unpinned on THIS machine. Pull filters remote pins through this
 *     so a remote that still has the pin can't bring it back.
 *   - Synced: `sync-repo/.tombstones/pins/<name>.json` — names any
 *     machine has unpinned, propagated via the existing git push/pull.
 *     Pull also filters remote pins through THIS so a machine that
 *     unpinned Sample propagates the delete to every other machine.
 *
 * Resurrection: re-pinning a name removes its tombstone from BOTH
 * stores. That's the "I changed my mind, pin it again" signal that
 * overrides the prior delete.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface PinTombstone {
  name: string;
  removedAt: string; // ISO timestamp
  machine: string;
}

export interface PinTombstonePaths {
  /** Local tombstone file — per-machine, holds names of pins unpinned here. */
  localFile: string;
  /** Synced tombstones dir — propagates via sync-repo git push/pull. */
  syncDir: string;
}

export function pinTombstonePaths(dataDir: string, syncRepoDir: string): PinTombstonePaths {
  return {
    localFile: join(dataDir, "sync-state", "pin-tombstones.json"),
    syncDir: join(syncRepoDir, ".tombstones", "pins"),
  };
}

function readLocal(paths: PinTombstonePaths): PinTombstone[] {
  if (!existsSync(paths.localFile)) return [];
  try { return JSON.parse(readFileSync(paths.localFile, "utf-8")) as PinTombstone[]; }
  catch { return []; }
}

function writeLocal(paths: PinTombstonePaths, tombstones: PinTombstone[]): void {
  mkdirSync(join(paths.localFile, ".."), { recursive: true });
  writeFileSync(paths.localFile, JSON.stringify(tombstones, null, 2), "utf-8");
}

function readSynced(paths: PinTombstonePaths): PinTombstone[] {
  if (!existsSync(paths.syncDir)) return [];
  const out: PinTombstone[] = [];
  for (const file of readdirSync(paths.syncDir)) {
    if (!file.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(paths.syncDir, file), "utf-8")) as PinTombstone); }
    catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Write a tombstone for `name` locally AND into the synced store so
 * other machines see the delete on next pull. Idempotent.
 */
export function tombstonePin(paths: PinTombstonePaths, name: string): void {
  const tombstone: PinTombstone = {
    name,
    removedAt: new Date().toISOString(),
    machine: hostname(),
  };
  // Local store
  const local = readLocal(paths);
  if (!local.some(t => t.name === name)) local.push(tombstone);
  writeLocal(paths, local);
  // Synced store. Always written so the tombstone propagates on the
  // next sync push. If sync is disabled, the file just sits in
  // ~/.lax/sync-repo/.tombstones/pins/ — harmless until sync turns on.
  mkdirSync(paths.syncDir, { recursive: true });
  writeFileSync(join(paths.syncDir, `${safeFilename(name)}.json`), JSON.stringify(tombstone, null, 2), "utf-8");
}

/**
 * Clear a tombstone for `name` from BOTH stores. Called when the user
 * re-pins a previously-tombstoned name — the new pin is the signal of
 * intent, overriding the prior delete.
 */
export function clearPinTombstone(paths: PinTombstonePaths, name: string): void {
  const local = readLocal(paths).filter(t => t.name !== name);
  writeLocal(paths, local);
  const syncedFile = join(paths.syncDir, `${safeFilename(name)}.json`);
  if (existsSync(syncedFile)) {
    try { unlinkSync(syncedFile); } catch { /* best-effort */ }
  }
}

/**
 * List all tombstoned pin names (local + synced, deduped). Pull-files
 * uses this set to filter remote pins before replacing local.
 */
export function listTombstonedPinNames(paths: PinTombstonePaths): Set<string> {
  const set = new Set<string>();
  for (const t of readLocal(paths)) set.add(t.name);
  for (const t of readSynced(paths)) set.add(t.name);
  return set;
}

/**
 * Apply tombstones to a pin list — drop any pin whose name is
 * tombstoned. Pure function, easy to test.
 */
export function applyPinTombstones<T extends { name: string }>(
  pins: T[],
  tombstonedNames: Set<string>,
): T[] {
  return pins.filter(p => !tombstonedNames.has(p.name));
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "unnamed";
}
