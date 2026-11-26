/**
 * Settling a worktree merge that stopped on conflicts, for a caller that knows
 * some files are safe to settle by rule.
 *
 * mergeWorktree (worktree-lifecycle.ts) merges the base INTO the worktree's
 * branch, so a conflict stays in the worktree and never reaches a person's
 * checkout. By default a conflict ends the merge: it is aborted and the branch
 * is kept for a person. A caller may pass a resolver instead. The resolver is
 * handed the conflicted files and either settles ALL of them (with the
 * helpers here) or says no; a half-settled merge is still aborted. Nothing
 * here decides WHICH files may be settled by rule: that is the caller's
 * knowledge of its own project (auto-build/loop/shared-file-merge.ts).
 *
 * In the worktree's merge, "ours" is the worktree's branch and "theirs" is the
 * base being merged in.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, commitWithFallbackIdentity } from "./worktree-core.js";

/** Settle every file in `conflicted` (repo-relative paths) in the worktree at
 *  `worktreePath` and return true, or return false to leave the merge to be
 *  aborted. */
export type MergeConflictResolver = (worktreePath: string, conflicted: string[]) => boolean;

/** The files a merge in progress in `worktreePath` could not combine. */
export function conflictedFiles(worktreePath: string): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"], worktreePath).split("\n").map((f) => f.trim()).filter(Boolean);
}

/**
 * A merge in `worktreePath` just stopped. Let `resolve` settle its conflicts
 * and make the merge commit. True only when there were conflicts, the resolver
 * took them all, none is left, and the commit was made; false in every other
 * case, and the caller aborts the merge.
 */
export function concludeResolvedMerge(worktreePath: string, resolve: MergeConflictResolver | undefined): boolean {
  if (!resolve) return false;
  try {
    const conflicted = conflictedFiles(worktreePath);
    if (conflicted.length === 0) return false; // the merge failed for another reason
    if (!resolve(worktreePath, conflicted)) return false;
    if (conflictedFiles(worktreePath).length > 0) return false;
    commitWithFallbackIdentity(["--no-edit"], worktreePath);
    return true;
  } catch {
    return false; // a resolver or git error leaves the merge unsettled: it is aborted
  }
}

/** One side of a conflicted file as git recorded it, or "" when that side has
 *  none (both sides added the file: there is no common ancestor). */
function stage(worktreePath: string, n: 1 | 2 | 3, file: string): string {
  try { return git(["show", `:${n}:${file}`], worktreePath); } catch { return ""; }
}

/**
 * Settle a conflicted file by keeping BOTH sides' lines (git's union merge):
 * right for a file each side only adds to, a list or a table of rows. Never
 * for code: the result is every line from both, in file order, unchecked.
 */
export function unionMergeConflicted(worktreePath: string, file: string): void {
  const dir = mkdtempSync(join(tmpdir(), "lax-union-merge-"));
  try {
    const sides = { ours: stage(worktreePath, 2, file), base: stage(worktreePath, 1, file), theirs: stage(worktreePath, 3, file) };
    for (const [name, text] of Object.entries(sides)) writeFileSync(join(dir, name), text ? `${text}\n` : "");
    const merged = git(["merge-file", "-p", "--union", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], worktreePath);
    writeFileSync(join(worktreePath, file), `${merged}\n`);
    git(["add", "--", file], worktreePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Settle a conflicted file by taking the base's copy whole: right only for a
 *  file the caller will produce again from the merged tree. */
export function takeBaseCopy(worktreePath: string, file: string): void {
  git(["checkout", "--theirs", "--", file], worktreePath);
  git(["add", "--", file], worktreePath);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (v: Json | undefined): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
const byName = (a: string, b: string): number => a.localeCompare(b, "en");
const inOrder = (keys: string[]): boolean => keys.every((key, i) => i === 0 || byName(keys[i - 1], key) <= 0);

/**
 * One value merged three ways; `undefined` is "the key is absent". A side that
 * left the value as the ancestor had it yields to the side that changed it.
 * Two objects merge key by key. Anything else both sides changed differently
 * is a conflict: `null`.
 */
function mergeJsonValue(base: Json | undefined, ours: Json | undefined, theirs: Json | undefined): { value: Json | undefined } | null {
  if (same(ours, theirs) || same(base, theirs)) return { value: ours };
  if (same(base, ours)) return { value: theirs };
  if (!isObject(ours) || !isObject(theirs)) return null;
  const ancestor = isObject(base) ? base : {};
  const keys = [...Object.keys(theirs), ...Object.keys(ours).filter((key) => !(key in theirs))];
  // An object the base kept in name order (a dependency map) stays in it.
  if (inOrder(Object.keys(theirs))) keys.sort(byName);
  const merged: JsonObject = {};
  for (const key of keys) {
    const entry = mergeJsonValue(ancestor[key], ours[key], theirs[key]);
    if (!entry) return null;
    if (entry.value !== undefined) merged[key] = entry.value;
  }
  return { value: merged };
}

function parseJson(text: string): Json | undefined {
  try { return JSON.parse(text) as Json; } catch { return undefined; }
}

/**
 * Settle a conflicted JSON file key by key: right for a manifest where each
 * side added its own entries (two chunks each adding a package to
 * package.json), which git's line merge calls a conflict because the lines
 * touch. Returns false, with the file left conflicted, when a side is not
 * JSON or both sides gave one key different values: that is a decision.
 */
export function mergeJsonConflicted(worktreePath: string, file: string): boolean {
  const theirsText = stage(worktreePath, 3, file);
  const ours = parseJson(stage(worktreePath, 2, file));
  const theirs = parseJson(theirsText);
  if (ours === undefined || theirs === undefined) return false;
  const merged = mergeJsonValue(parseJson(stage(worktreePath, 1, file)), ours, theirs);
  if (!merged || merged.value === undefined) return false;
  const indent = theirsText.match(/^([ \t]+)"/m)?.[1] ?? "  ";
  writeFileSync(join(worktreePath, file), `${JSON.stringify(merged.value, null, indent)}\n`);
  git(["add", "--", file], worktreePath);
  return true;
}
