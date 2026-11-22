/**
 * Settling a worktree merge that stopped on conflicts, for a caller that knows
 * some files are safe to settle by rule.
 *
 * mergeWorktree (worktree-lifecycle.ts) merges the base INTO the worktree's
 * branch, so a conflict stays in the worktree and never reaches a person's
 * checkout. By default a conflict ends the merge: it is aborted and the branch
 * is kept for a person. A caller may pass a resolver instead. The resolver is
 * handed the conflicted files and either settles ALL of them (with the two
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

function conflictedFiles(worktreePath: string): string[] {
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
