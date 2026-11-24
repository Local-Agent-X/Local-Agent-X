/**
 * A set-aside chunk picks up where the last run left it.
 *
 * A chunk an earlier run set aside keeps its work on a branch and its findings
 * in the build history (failure-recovery.ts recordSetAside). The next run used
 * to cut a fresh worktree from base and build the chunk from nothing: it lost
 * the fixes the last run made and met a new finding each time (label-check's
 * chunk 3, set aside in four runs on six branches, 2026-11-22). Now the kept
 * branch is merged into the chunk's fresh worktree before the worker starts,
 * and the worker's brief carries every earlier finding to keep fixed. When the
 * kept work no longer merges with base, the merge is undone and the chunk
 * builds fresh, still with the findings.
 */
import { git } from "../../agency/worktree-core.js";
import { HARNESS_COMMIT_IDENTITY, isNoGitIdentity } from "../../git-safety.js";
import { setAsideRecordFor } from "../failure-recovery.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { EmitFn } from "./types.js";

export interface CarryOver {
  /** The branch the earlier run kept the chunk's work on, when it still exists. */
  branch?: string;
  /** What earlier reviews found, oldest first. */
  findings: string[];
}

/** What an earlier run left for `chunk`, or null when it was never set aside. */
export function carryOverFor(projectDir: string, chunk: number): CarryOver | null {
  const record = setAsideRecordFor(projectDir, chunk);
  if (!record || (!record.branch && record.findings.length === 0)) return null;
  const branch = record.branch && branchExists(record.branch, projectDir) ? record.branch : undefined;
  return { ...(branch ? { branch } : {}), findings: record.findings };
}

function branchExists(branch: string, cwd: string): boolean {
  try { git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd); return true; } catch { return false; }
}

/**
 * Merge the kept branch into the chunk's fresh worktree. Returns whether the
 * work came along; a conflicting merge is aborted and the tree is left as cut.
 */
export function mergeCarriedWork(worktreePath: string, branch: string): { merged: boolean; detail: string } {
  const merge = ["merge", "--no-edit", "--no-ff", branch];
  try {
    try {
      git(merge, worktreePath);
    } catch (e) {
      if (!isNoGitIdentity((e as Error).message)) throw e;
      git([...HARNESS_COMMIT_IDENTITY, ...merge], worktreePath);
    }
    return { merged: true, detail: `merged '${branch}'` };
  } catch (e) {
    try { git(["merge", "--abort"], worktreePath); } catch { /* nothing in progress: the merge never started */ }
    return { merged: false, detail: (e as Error).message.replace(/\s+/g, " ").slice(0, 300) };
  }
}

/** The opening of the worker's brief for a chunk an earlier run set aside. */
export function carryOverBrief(carry: CarryOver, merged: boolean): string {
  const work = carry.branch
    ? merged
      ? `An earlier run built this chunk and it was set aside. Its work (branch '${carry.branch}') is already merged into your tree: keep what holds and fix what was found, do not start over.`
      : `An earlier run built this chunk and it was set aside. Its work on branch '${carry.branch}' no longer merges with the current base, so you start fresh: read it (git show ${carry.branch}) and reuse what still applies.`
    : `An earlier run built this chunk and it was set aside.`;
  const found = carry.findings.length
    ? `\n\nWhat the reviews found in earlier runs. Fix each, and fix the class of input each one belongs to, not only the example given: the reviewer will try its siblings. Keep every one of them fixed:\n` +
      carry.findings.map((f) => `- ${f.replace(/\s+/g, " ").trim()}`).join("\n")
    : "";
  return work + found;
}

/**
 * Start a chunk an earlier run set aside from its kept work and findings:
 * merge the kept branch into `tree` (the chunk's worktree, or the project
 * itself for a chunk built there) and say so. Returns the opening of the
 * worker's brief and the findings its fix rounds keep fixed; undefined for a
 * chunk building for the first time.
 */
export function pickUpSetAsideWork(a: { projectDir: string; tree: string; chunk: ParsedChunk; totalChunks: number; emit: EmitFn }): { brief: string; findings: string[] } | undefined {
  const { chunk } = a;
  const carry = carryOverFor(a.projectDir, chunk.number);
  if (!carry) return undefined;
  const merge = carry.branch ? mergeCarriedWork(a.tree, carry.branch) : null;
  a.emit({
    type: "review-result", chunkNumber: chunk.number, totalChunks: a.totalChunks,
    message: merge
      ? merge.merged
        ? `Chunk ${chunk.number} picks up the last run's work from '${carry.branch}', with ${carry.findings.length} earlier finding(s) to keep fixed.`
        : `Chunk ${chunk.number}'s last work on '${carry.branch}' no longer merges (${merge.detail}); building fresh with ${carry.findings.length} earlier finding(s).`
      : `Chunk ${chunk.number} builds with ${carry.findings.length} finding(s) from earlier runs.`,
  });
  return { brief: carryOverBrief(carry, merge?.merged ?? false), findings: carry.findings };
}
