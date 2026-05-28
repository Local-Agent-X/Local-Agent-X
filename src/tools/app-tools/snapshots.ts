/**
 * Per-turn snapshots of app files + one-click undo.
 *
 * Most user apps in workspace/apps/<id>/ aren't git repos, so there's no
 * built-in recovery path when the agent edits the wrong file or breaks
 * something. This module copies the FILES THE AGENT TOUCHED THIS TURN into
 * ~/.lax/app-snapshots/<appId>/<turnIdx>-<ts>/ — preserving relative paths
 * — so the IDE topbar can offer a "↺ Revert" dropdown over the last 5
 * turns. Whole-tree mirroring was avoided on purpose: it's too slow on
 * apps that bundle node_modules and burns disk for snapshots no one ever
 * uses.
 *
 * Pure-where-possible: every fs call is localized to one of the three
 * exported functions so the unit tests can drive each in isolation.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("app-tools.snapshots");

/** Cap so the dropdown never balloons past what a user can reason about. */
export const SNAPSHOTS_TO_KEEP = 5;
/** Hard ceiling for on-disk retention; older directories are pruned. */
const HARD_CAP = 30;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppSnapshot {
  turnIdx: number;
  ts: number;
  files: string[];
}

export interface RevertResult {
  restored: string[];
  errors: string[];
}

function snapshotsRoot(): string {
  return join(getLaxDir(), "app-snapshots");
}

function appSnapshotDir(appId: string): string {
  return join(snapshotsRoot(), appId);
}

function parseSnapshotName(name: string): { turnIdx: number; ts: number } | null {
  // Format: "<turnIdx>-<ts>" — both decimal, ts is ms since epoch.
  const m = name.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { turnIdx: parseInt(m[1], 10), ts: parseInt(m[2], 10) };
}

function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Snapshot the files the agent wrote/edited this turn into
 * ~/.lax/app-snapshots/<appId>/<turnIdx>-<ts>/.
 *
 * Path safety: every `touchedFiles` entry is resolved against `workspaceDir`
 * and rejected if it doesn't sit inside `workspace/apps/<appId>/`. Files
 * that don't exist (model claimed a path that never landed) and
 * directories are silently skipped — snapshots should never error the
 * turn pipeline.
 */
export function snapshotAppTurn(
  appId: string,
  workspaceDir: string,
  turnIdx: number,
  touchedFiles: string[],
): { snapshotDir: string; copied: string[] } | null {
  if (!appId || touchedFiles.length === 0) return null;
  const appDir = resolve(workspaceDir, "apps", appId);
  // Pre-check: each touched file must resolve to a path inside appDir.
  // We use relative() rather than startsWith string-matching because the
  // latter has subtle separator-boundary bugs across OSes (e.g.
  // `/a/apps/foo` is a false-positive prefix of `/a/apps/foobar`). A
  // relative path that begins with `..` (or is absolute when isAbsolute
  // returns true) means the file is outside the app dir — skip it.
  const candidates: { abs: string; rel: string }[] = [];
  for (const raw of touchedFiles) {
    const abs = resolve(raw);
    const rel = relative(appDir, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) continue;
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isDirectory()) continue;
    } catch { continue; }
    candidates.push({ abs, rel });
  }
  if (candidates.length === 0) return null;

  const ts = Date.now();
  const snapshotDir = join(appSnapshotDir(appId), `${turnIdx}-${ts}`);
  const copied: string[] = [];
  try {
    mkdirSync(snapshotDir, { recursive: true });
    for (const { abs, rel } of candidates) {
      const dest = join(snapshotDir, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(abs, dest, { recursive: false });
        copied.push(rel);
      } catch (e) {
        logger.warn(`[snapshots] copy failed ${rel}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.warn(`[snapshots] mkdir failed: ${(e as Error).message}`);
    return null;
  }
  // Fire-and-forget prune so disk doesn't grow unbounded over months of use.
  try { pruneOldSnapshots(appId); } catch { /* prune is best-effort */ }
  return { snapshotDir, copied };
}

/** Newest-first, capped at SNAPSHOTS_TO_KEEP. Files list is per-snapshot. */
export function listAppSnapshots(appId: string): AppSnapshot[] {
  const dir = appSnapshotDir(appId);
  if (!existsSync(dir)) return [];
  const entries: AppSnapshot[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
    } catch { continue; }
    entries.push({
      turnIdx: parsed.turnIdx,
      ts: parsed.ts,
      files: walkFiles(full),
    });
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries.slice(0, SNAPSHOTS_TO_KEEP);
}

/**
 * Restore the snapshot at `<turnIdx>-<ts>` back over the app directory.
 * Idempotent: re-running with the same snapshot is a no-op overwrite.
 * Path-safety: dest paths are re-validated to live inside appDir even
 * though they were validated on snapshot — defense in depth.
 */
export function revertAppToSnapshot(
  appId: string,
  workspaceDir: string,
  turnIdx: number,
  ts: number,
): RevertResult {
  const appDir = resolve(workspaceDir, "apps", appId);
  const snapDir = join(appSnapshotDir(appId), `${turnIdx}-${ts}`);
  if (!existsSync(snapDir)) {
    return { restored: [], errors: [`Snapshot not found: ${turnIdx}-${ts}`] };
  }
  const restored: string[] = [];
  const errors: string[] = [];
  for (const rel of walkFiles(snapDir)) {
    const src = join(snapDir, rel);
    const dest = resolve(appDir, rel);
    if (!dest.startsWith(appDir)) {
      errors.push(`Refused (path traversal): ${rel}`);
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: false });
      restored.push(rel);
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return { restored, errors };
}

function pruneOldSnapshots(appId: string): void {
  const dir = appSnapshotDir(appId);
  if (!existsSync(dir)) return;
  const now = Date.now();
  const all: { name: string; ts: number }[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    all.push({ name, ts: parsed.ts });
  }
  all.sort((a, b) => b.ts - a.ts);
  const survivors = new Set<string>();
  // Always keep the newest HARD_CAP under MAX_AGE_MS.
  for (const entry of all.slice(0, HARD_CAP)) {
    if (now - entry.ts <= MAX_AGE_MS) survivors.add(entry.name);
  }
  for (const entry of all) {
    if (survivors.has(entry.name)) continue;
    try { rmSync(join(dir, entry.name), { recursive: true, force: true }); }
    catch (e) { logger.warn(`[snapshots] prune ${entry.name}: ${(e as Error).message}`); }
  }
}

/**
 * Extract `{appId, paths}` pairs from a turn's tool calls. Only write/edit
 * (the deterministic mutation tools) are considered — bash can mutate
 * files too but it's too noisy to snapshot every shell command's effect.
 * Returns a Map keyed by appId so multi-app turns produce one snapshot
 * per app.
 */
export function extractAppTouchesFromToolCalls(
  toolCalls: Array<{ tool: string; args: unknown }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const call of toolCalls) {
    if (call.tool !== "write" && call.tool !== "edit") continue;
    const args = call.args as { path?: unknown; file_path?: unknown } | null | undefined;
    const raw = args?.path ?? args?.file_path;
    if (typeof raw !== "string") continue;
    const norm = raw.replace(/\\/g, "/");
    const m = norm.match(/(?:^|\/)workspace\/apps\/([^/]+)\//);
    if (!m) continue;
    const appId = m[1];
    if (!appId || appId === "_audit") continue;
    const existing = out.get(appId);
    if (existing) existing.push(raw);
    else out.set(appId, [raw]);
  }
  return out;
}
