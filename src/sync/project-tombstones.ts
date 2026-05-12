/**
 * Project-entry tombstones — explicit "I deleted this project" intent
 * that survives a sync pull.
 *
 * Why this exists: agent-projects.json is shipped whole (last-push-wins)
 * via BRAIN_JSON_FILES. That means a project deleted on machine A, then
 * a push from machine B (which still had it), brings the project back
 * on A's next pull. Same bug shape as sidebar-pins and workspace/apps,
 * different file.
 *
 * Two tombstone stores (mirrors pin-tombstones):
 *   - Local: `~/.lax/sync-state/project-tombstones.json` — IDs deleted
 *     on THIS machine. Pull filters the remote agent-projects.json
 *     through this set.
 *   - Synced: `sync-repo/.tombstones/projects/<id>.json` — IDs any
 *     machine has deleted, propagated via the existing git push/pull.
 *
 * Resurrection: re-creating a project with the same ID clears that
 * ID's tombstone from both stores. (Practically, new projects get a
 * fresh ID so this rarely fires — but it's the right semantics.)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface ProjectTombstone {
  id: string;
  name?: string; // best-effort label for log/debug; not load-bearing
  deletedAt: string;
  machine: string;
}

export interface ProjectTombstonePaths {
  localFile: string;
  syncDir: string;
}

export function projectTombstonePaths(dataDir: string, syncRepoDir: string): ProjectTombstonePaths {
  return {
    localFile: join(dataDir, "sync-state", "project-tombstones.json"),
    syncDir: join(syncRepoDir, ".tombstones", "projects"),
  };
}

function readLocal(paths: ProjectTombstonePaths): ProjectTombstone[] {
  if (!existsSync(paths.localFile)) return [];
  try { return JSON.parse(readFileSync(paths.localFile, "utf-8")) as ProjectTombstone[]; }
  catch { return []; }
}

function writeLocal(paths: ProjectTombstonePaths, tombstones: ProjectTombstone[]): void {
  mkdirSync(join(paths.localFile, ".."), { recursive: true });
  writeFileSync(paths.localFile, JSON.stringify(tombstones, null, 2), "utf-8");
}

function readSynced(paths: ProjectTombstonePaths): ProjectTombstone[] {
  if (!existsSync(paths.syncDir)) return [];
  const out: ProjectTombstone[] = [];
  for (const file of readdirSync(paths.syncDir)) {
    if (!file.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(paths.syncDir, file), "utf-8")) as ProjectTombstone); }
    catch { /* skip malformed */ }
  }
  return out;
}

export function tombstoneProject(paths: ProjectTombstonePaths, id: string, name?: string): void {
  const tombstone: ProjectTombstone = {
    id,
    name,
    deletedAt: new Date().toISOString(),
    machine: hostname(),
  };
  const local = readLocal(paths);
  if (!local.some(t => t.id === id)) local.push(tombstone);
  writeLocal(paths, local);
  mkdirSync(paths.syncDir, { recursive: true });
  writeFileSync(join(paths.syncDir, `${safeFilename(id)}.json`), JSON.stringify(tombstone, null, 2), "utf-8");
}

export function clearProjectTombstone(paths: ProjectTombstonePaths, id: string): void {
  const local = readLocal(paths).filter(t => t.id !== id);
  writeLocal(paths, local);
  const syncedFile = join(paths.syncDir, `${safeFilename(id)}.json`);
  if (existsSync(syncedFile)) {
    try { unlinkSync(syncedFile); } catch { /* best-effort */ }
  }
}

export function listTombstonedProjectIds(paths: ProjectTombstonePaths): Set<string> {
  const set = new Set<string>();
  for (const t of readLocal(paths)) set.add(t.id);
  for (const t of readSynced(paths)) set.add(t.id);
  return set;
}

export function applyProjectTombstones<T extends { id: string }>(
  projects: T[],
  tombstonedIds: Set<string>,
): T[] {
  return projects.filter(p => !tombstonedIds.has(p.id));
}

function safeFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "unnamed";
}
