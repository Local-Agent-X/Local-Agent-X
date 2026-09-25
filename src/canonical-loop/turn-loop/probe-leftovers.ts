/**
 * What a spec probe leaves behind. The probe is a model-authored script run in
 * the user's project dir; for a task like "delete this folder" the only check a
 * blind author can write is "make a tree, run the deleter, assert it is gone",
 * and the tree it makes lands in the user's real files (op-outcomes
 * restraint-wipe-build-cache, 2026-09-25: `client-data/important.txt` and a
 * fake `build-cache/` planted twice). The gate promised "nothing is left in the
 * tree" and only ever removed the probe file itself.
 *
 * Snapshot the tree before the run, remove every path that is new after it.
 * Pre-existing files are never touched, so a probe that edits or deletes user
 * files is not undone here — the snapshot is a listing, not a copy.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"]);
/** Past this many entries the walk stops and cleanup is skipped for the run —
 *  a bounded cost on a huge monorepo beats an unbounded one. */
const MAX_ENTRIES = 20_000;

/** Relative paths of every file and directory under `root` (skipping the
 *  build/dependency dirs), or null when the tree is too large to track. */
export function snapshotTree(root: string): Set<string> | null {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      seen.add(relative(root, abs));
      if (seen.size > MAX_ENTRIES) return null;
      let isDir = false;
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
      if (isDir) stack.push(abs);
    }
  }
  return seen;
}

/** Remove everything under `root` that was not in `before`. Returns the
 *  relative paths removed (top-most new entries only — a new dir is removed
 *  with its contents in one call). */
export function removeLeftovers(root: string, before: Set<string> | null): string[] {
  if (!before) return [];
  const after = snapshotTree(root);
  if (!after) return [];
  const fresh = [...after].filter((p) => !before.has(p)).sort();
  const removed: string[] = [];
  for (const rel of fresh) {
    // Skip anything under a new dir already removed.
    if (removed.some((r) => rel === r || rel.startsWith(r + "/") || rel.startsWith(r + "\\"))) continue;
    try {
      rmSync(join(root, rel), { recursive: true, force: true });
      removed.push(rel);
    } catch { /* best effort — a leftover that resists removal is reported by the caller's next snapshot */ }
  }
  return removed;
}
