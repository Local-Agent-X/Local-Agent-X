import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { unionMergeBy } from "./pull-files/merge-helpers.js";

const logger = createLogger("sync.conflict-resolver");

export type GitFn = (...args: string[]) => Promise<string>;

/**
 * Union the two sides of every conflict hunk, leaving non-conflicted text
 * byte-for-byte untouched. Emits ours-lines then the theirs-lines not already
 * in ours; diff3 base sections are dropped. Used for line-oriented text
 * (.md prose, .jsonl fact logs) — unlike the old whole-file trim + Set-dedup,
 * this never reflows narrative outside the conflicted regions.
 */
export function unionMergeConflictHunks(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<< ")) { out.push(lines[i]); i++; continue; }
    i++;
    const ours: string[] = [];
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (section !== "theirs" && l.startsWith("|||||||")) { section = "base"; continue; }
      if (section !== "theirs" && l === "=======") { section = "theirs"; continue; }
      if (l.startsWith(">>>>>>> ")) { i++; break; }
      if (section === "ours") ours.push(l);
      else if (section === "theirs") theirs.push(l);
    }
    const seen = new Set(ours);
    out.push(...ours, ...theirs.filter((t) => !seen.has(t)));
  }
  return out.join("\n");
}

/**
 * Structured merge of the two sides of a conflicted JSON file. Record arrays
 * union-merge by `id` with `updatedAt`/`updated_at` tiebreak (same semantics
 * as the pull-side merge blocks); id-less items dedup by content. Non-array
 * JSON (config objects like mcp.json) keeps the local side — no timestamp to
 * merge by, and the pull-side per-file merges reconcile object shapes.
 * Returns null only when NEITHER side parses.
 */
export function mergeJsonSides(oursText: string, theirsText: string): string | null {
  let ours: unknown, theirs: unknown;
  let oursOk = true, theirsOk = true;
  try { ours = JSON.parse(oursText); } catch { oursOk = false; }
  try { theirs = JSON.parse(theirsText); } catch { theirsOk = false; }
  if (!oursOk && !theirsOk) return null;
  if (!oursOk) return JSON.stringify(theirs, null, 2);
  if (!theirsOk) return JSON.stringify(ours, null, 2);
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const keyOf = (x: unknown): string => {
      const id = (x as { id?: unknown } | null)?.id;
      return typeof id === "string" && id ? id : JSON.stringify(x);
    };
    const stamp = (x: unknown): number => {
      const o = x as { updatedAt?: unknown; updated_at?: unknown } | null;
      return Number(o?.updatedAt ?? o?.updated_at) || 0;
    };
    return JSON.stringify(unionMergeBy(ours, theirs, keyOf, (l, r) => stamp(l) > stamp(r)), null, 2);
  }
  return JSON.stringify(ours, null, 2);
}

export async function resolveConflicts(syncDir: string, git: GitFn): Promise<void> {
  try {
    const status = await git("status", "--porcelain");
    const conflicted = status.split("\n").filter(l => l.startsWith("UU ") || l.startsWith("AA "));
    for (const line of conflicted) {
      const file = line.slice(3).trim();
      const fullPath = join(syncDir, file);
      if (file.endsWith(".json")) {
        // Structured merge from the index stages (:2 = ours/local, :3 = theirs/
        // remote). NEVER commit marker-laced JSON: one `<<<<<<<` in tasks.json
        // makes every machine JSON.parse-throw on pull, and that brain file
        // silently stops syncing until hand-repaired.
        let merged: string | null = null;
        try {
          merged = mergeJsonSides(await git("show", `:2:${file}`), await git("show", `:3:${file}`));
        } catch (e) {
          logger.warn(`[sync] could not read index stages for ${file}: ${(e as Error).message}`);
        }
        if (merged !== null) {
          writeFileSync(fullPath, merged + "\n");
        } else if (existsSync(fullPath)) {
          // Neither side parses (or stages unreadable): hunk-union the working
          // copy so we at least never push conflict markers.
          writeFileSync(fullPath, unionMergeConflictHunks(readFileSync(fullPath, "utf-8")));
        }
      } else if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        // Only rewrite when markers are present — binary conflicts (git keeps
        // ours in the working tree, no markers) must not utf-8 round-trip.
        if (content.includes("<<<<<<< ")) writeFileSync(fullPath, unionMergeConflictHunks(content));
      }
      await git("add", file);
    }
    if (conflicted.length > 0) await git("commit", "-m", "auto-merge: union merge resolved conflicts");
  } catch (e) {
    logger.warn(`[sync] conflict resolution failed: ${(e as Error).message}`);
  }
}
