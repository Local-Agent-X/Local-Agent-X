import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../../logger.js";

const logger = createLogger("sync.pull-files.merge-helpers");

/**
 * Generic union-merge of two record arrays by a caller-supplied key, with
 * a caller-supplied collision predicate that decides whether local or
 * remote wins. Items with an empty / falsy key are skipped.
 *
 * Three callers today: id+updatedAt records (projects/issues/templates),
 * id+updated_at snake_case (tasks), name-keyed without a timestamp
 * (sidebar pins, custom missions, calendar events).
 */
export function unionMergeBy<T>(
  local: T[],
  remote: T[],
  keyOf: (item: T) => string,
  localWins: (l: T, r: T) => boolean,
): T[] {
  const byKey = new Map<string, T>();
  for (const r of remote) {
    const k = keyOf(r);
    if (k) byKey.set(k, r);
  }
  for (const l of local) {
    const k = keyOf(l);
    if (!k) continue;
    const r = byKey.get(k);
    if (!r || localWins(l, r)) byKey.set(k, l);
  }
  return Array.from(byKey.values());
}

/**
 * Union-merge by `id` with `updatedAt` tiebreak (camelCase). The original
 * helper, kept as a convenience wrapper because three call sites use it
 * (agent-projects.json, agent-issues.json, agent-templates.json).
 */
export function unionMergeRecordsById<T extends { id: string; updatedAt?: number }>(
  local: T[],
  remote: T[],
): T[] {
  return unionMergeBy(
    local,
    remote,
    (x) => x.id,
    (l, r) => (Number(l.updatedAt) || 0) > (Number(r.updatedAt) || 0),
  );
}

/**
 * Pull a JSON file that contains a record array with `{id, updatedAt}`
 * shape, union-merging local + remote rather than overwriting. Optional
 * tombstone filter runs AFTER the merge so deletes still propagate.
 *
 * Used by agent-projects.json, agent-issues.json, and agent-templates.json
 * — all three are user-data record arrays where a locally-newer entry
 * MUST survive a pull from a stale remote.
 */
export function pullMergedRecordFile<T extends { id: string; updatedAt?: number }>(opts: {
  dataDir: string;
  syncDir: string;
  fileName: string;
  filterTombstoned?: (records: T[]) => T[];
}): void {
  const remotePath = join(opts.syncDir, opts.fileName);
  const localPath = join(opts.dataDir, opts.fileName);
  if (!existsSync(remotePath)) return;
  try {
    const remote = JSON.parse(readFileSync(remotePath, "utf-8"));
    const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf-8")) : [];
    if (!Array.isArray(remote) || !Array.isArray(local)) return;
    let merged = unionMergeRecordsById<T>(local as T[], remote as T[]);
    if (opts.filterTombstoned) merged = opts.filterTombstoned(merged);
    writeFileSync(localPath, JSON.stringify(merged, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[sync] ${opts.fileName} pull skipped: ${(e as Error).message}`);
  }
}

/** Files whose pull goes through an explicit merge block, not the
 *  destructive overwrite loop. Keep in sync with the per-file blocks. */
export const MERGED_BRAIN_FILES: ReadonlySet<string> = new Set([
  "agent-projects.json",
  "agent-issues.json",
  "agent-templates.json",
  "tasks.json",
  "calendar.json",
  "custom-missions.json",
  "mcp.json",
  "hooks.json",
]);
