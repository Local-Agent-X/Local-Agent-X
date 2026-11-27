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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { FIX_THE_CLASS } from "../chunk-review/skeptic-bar.js";
import { git, gitWritingCommit } from "../../agency/worktree-core.js";
import { conflictedFiles } from "../../agency/worktree-merge-conflicts.js";
import { setAsideRecordFor } from "../failure-recovery.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { EmitFn } from "./types.js";

export interface CarryOver {
  /** The branch the earlier run kept the chunk's work on, when it still exists. */
  branch?: string;
  /** What earlier reviews found, oldest first. */
  findings: string[];
  /** Paused mid-build: the fix round it was on (failure-recovery.ts). */
  round?: number;
}

/** What an earlier run left for `chunk`, or null when it was never set aside. */
export function carryOverFor(projectDir: string, chunk: number): CarryOver | null {
  const record = setAsideRecordFor(projectDir, chunk);
  if (!record || (!record.branch && record.findings.length === 0)) return null;
  const branch = record.branch && branchExists(record.branch, projectDir) ? record.branch : undefined;
  return { ...(branch ? { branch } : {}), findings: record.findings, ...(record.round != null ? { round: record.round } : {}) };
}

function branchExists(branch: string, cwd: string): boolean {
  try { git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd); return true; } catch { return false; }
}

/**
 * Merge the kept branch into the chunk's fresh worktree. Returns whether the
 * work came along.
 *
 * A merge that stops on conflicts is LEFT in the tree, with the conflicted
 * files named: the work is there, and the chunk's worker combines the two
 * sides (carryOverBrief). It used to be aborted and the chunk rebuilt from
 * nothing, so a chunk set aside because it conflicted with a sibling was
 * built a second time on every resume: three reviewed chunks of one build
 * went that way in a day (label-check-grok, 2026-11-26). A merge that failed
 * for any other reason is aborted and the tree is left as cut.
 */
export function mergeCarriedWork(worktreePath: string, branch: string): { merged: boolean; detail: string; conflicted?: string[]; displaced?: string[] } {
  const merge = ["merge", "--no-edit", "--no-ff", branch];
  let displaced: string[] = [];
  try {
    try {
      gitWritingCommit(merge, worktreePath);
    } catch (e) {
      // Files the branch adds that sit untracked in the tree: what the chunk's
      // own earlier attempt left there when it was cut off. git refuses the
      // merge over them, and the chunk was rebuilt from nothing (finish fix
      // 1011, label-check-grok, 2026-11-27). The branch's copy is the kept
      // work; a tree copy that differs is saved inside .git, never lost.
      displaced = displaceUntrackedFor(worktreePath, branch, (e as Error).message);
      if (displaced.length === 0) throw e;
      gitWritingCommit(merge, worktreePath);
    }
    return { merged: true, detail: `merged '${branch}'`, ...(displaced.length ? { displaced } : {}) };
  } catch (e) {
    let conflicted: string[] = [];
    try { conflicted = conflictedFiles(worktreePath); } catch { /* no merge in progress */ }
    if (conflicted.length) return { merged: false, conflicted, detail: `conflicts in ${conflicted.join(", ")}` };
    try { git(["merge", "--abort"], worktreePath); } catch { /* nothing in progress: the merge never started */ }
    return { merged: false, detail: (e as Error).message.replace(/\s+/g, " ").slice(0, 300) };
  }
}

/**
 * Move out of the way the untracked files git named as blocking a merge of
 * `branch`, so the merge can take the branch's copies. A file identical to the
 * branch's is deleted; one that differs is saved under .git/lax-displaced/.
 * Returns the paths moved; none when the error was not that refusal.
 */
function displaceUntrackedFor(tree: string, branch: string, error: string): string[] {
  const listed = error.match(/untracked working tree files would be overwritten by merge:\s*([\s\S]*?)\s*Please move or remove/);
  if (!listed) return [];
  const paths = listed[1].split(/\s+/).filter(Boolean);
  const gitDir = git(["rev-parse", "--git-dir"], tree);
  const saveRoot = join(isAbsolute(gitDir) ? gitDir : join(tree, gitDir), "lax-displaced", String(Date.now()));
  const moved: string[] = [];
  for (const rel of paths) {
    const file = join(tree, rel);
    if (!existsSync(file)) continue;
    let theirs: string | null = null;
    try { theirs = git(["show", `${branch}:${rel}`], tree); } catch { /* not in the branch: keep it as found */ }
    if (theirs === null) continue;
    if (readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd() !== theirs.replace(/\r\n/g, "\n").trimEnd()) {
      mkdirSync(dirname(join(saveRoot, rel)), { recursive: true });
      copyFileSync(file, join(saveRoot, rel));
    }
    rmSync(file, { force: true });
    moved.push(rel);
  }
  return moved;
}

/**
 * Chunks whose work is on the project though no record says they landed: a
 * kill after a chunk's branch merged and before the run recorded it. Read from
 * git: one of the chunk's branches (`autobuild/c<N>`, or `-2`, `-3`, ... of it)
 * is merged into HEAD and ends in the chunk's own landing commit, made since
 * the killed run started. A branch that only holds preserved or set-aside
 * work does not count, and neither does a leftover of an older build, whose
 * chunk of the same number is a different chunk.
 */
export function landedUnrecorded(projectDir: string, chunks: readonly number[], runStartedAt: string): number[] {
  const since = Date.parse(runStartedAt);
  if (Number.isNaN(since)) return [];
  const found: number[] = [];
  for (const n of chunks) {
    let branches: string[];
    try {
      branches = git(["branch", "--merged", "HEAD", "--list", `autobuild/c${n}`, `autobuild/c${n}-*`, "--format=%(refname:short)"], projectDir).split("\n").filter(Boolean);
    } catch { continue; }
    const landed = branches.some((b) => {
      try {
        const [at, subject] = git(["log", "-1", "--format=%cI%x09%s", b], projectDir).split("\t");
        return subject.startsWith(`chunk ${n}: `) && Date.parse(at) >= since;
      } catch { return false; }
    });
    if (landed) found.push(n);
  }
  return found;
}

/** What a worker is told when its chunk's earlier work is in the tree with conflicts. */
export function conflictBrief(branch: string, conflicted: readonly string[]): string {
  return `Its work (branch '${branch}') is in your tree, merged with what has landed since, and the merge stopped on conflicts in: ${conflicted.join(", ")}. ` +
    "Both sides are real work: the project's side is what other chunks landed, the branch's side is this chunk's. " +
    "In each of those files, combine the two so that both still do what they were for, delete every conflict marker line, " +
    "and run the project's checks. Do not abort the merge, do not pick one side wholesale, and do not start over. " +
    "You do not need to commit: the build commits your tree when the chunk passes.";
}

/** The opening of the worker's brief for a chunk an earlier run set aside. */
export function carryOverBrief(carry: CarryOver, merged: boolean, conflicted: readonly string[] = []): string {
  const before = carry.round != null
    ? `The build was paused while this chunk was building (fix round ${carry.round}), and now goes on.`
    : `An earlier run built this chunk and it was set aside.`;
  const work = carry.branch
    ? merged
      ? `${before} Its work (branch '${carry.branch}') is already merged into your tree: keep what holds and fix what was found, do not start over.`
      : conflicted.length
        ? `${before} ${conflictBrief(carry.branch, conflicted)}`
        : `${before} Its work on branch '${carry.branch}' no longer merges with the current base, so you start fresh: read it (git show ${carry.branch}) and reuse what still applies.`
    : before;
  const found = carry.findings.length
    ? `\n\nWhat the reviews found in earlier runs. Fix each. ${FIX_THE_CLASS} Keep every one of them fixed:\n` +
      carry.findings.map((f) => `- ${f.replace(/\s+/g, " ").trim()}`).join("\n")
    : "";
  return work + found;
}

/** The opening of the worker's brief when its tree is the one a restart cut
 *  off mid-chunk (a crash, or LAX quit): the boot sweep kept it and the
 *  resumed build claimed it back (parallel-waves.ts, worktree-recovery.ts). */
export const INTERRUPTED_WORK_BRIEF =
  "LAX restarted while an earlier attempt was building this chunk, and that attempt's work is already in your tree: " +
  "the files it wrote (the last ones may be half-written) and any commits on this branch. Read what is there first " +
  "(git status, git diff, git log) and finish the chunk from it; do not start over. It may already be complete: then " +
  "check it against the chunk's done-when, run its checks, and stop.";

/** A chunk resuming in its interrupted tree: the restart note first, then
 *  what a set-aside carries, if the chunk was also set aside before. */
export function withInterruptedWork(
  carried: { brief: string; findings: string[] } | undefined,
  a: { chunk: ParsedChunk; totalChunks: number; emit: EmitFn },
): { brief: string; findings: string[] } {
  a.emit({
    type: "review-result", chunkNumber: a.chunk.number, totalChunks: a.totalChunks,
    message: `Chunk ${a.chunk.number} picks up the work its last attempt left in its worktree when LAX restarted.`,
  });
  return {
    brief: carried ? `${INTERRUPTED_WORK_BRIEF}\n\n${carried.brief}` : INTERRUPTED_WORK_BRIEF,
    findings: carried?.findings ?? [],
  };
}

/**
 * Start a chunk an earlier run set aside from its kept work and findings:
 * merge the kept branch into `tree` (the chunk's worktree, or the project
 * itself for a chunk built there) and say so. Returns the opening of the
 * worker's brief and the findings its fix rounds keep fixed; undefined for a
 * chunk building for the first time.
 */
export function pickUpSetAsideWork(a: { projectDir: string; tree: string; chunk: ParsedChunk; totalChunks: number; emit: EmitFn }): { brief: string; findings: string[]; round?: number } | undefined {
  const { chunk } = a;
  const carry = carryOverFor(a.projectDir, chunk.number);
  if (!carry) return undefined;
  const merge = carry.branch ? mergeCarriedWork(a.tree, carry.branch) : null;
  a.emit({
    type: "review-result", chunkNumber: chunk.number, totalChunks: a.totalChunks,
    message: merge
      ? merge.merged
        ? `Chunk ${chunk.number} picks up the last run's work from '${carry.branch}', with ${carry.findings.length} earlier finding(s) to keep fixed.`
        : merge.conflicted?.length
          ? `Chunk ${chunk.number}'s last work on '${carry.branch}' conflicts with what has landed since (${merge.conflicted.join(", ")}); its worker combines the two.`
          : `Chunk ${chunk.number}'s last work on '${carry.branch}' no longer merges (${merge.detail}); building fresh with ${carry.findings.length} earlier finding(s).`
      : `Chunk ${chunk.number} builds with ${carry.findings.length} finding(s) from earlier runs.`,
  });
  return { brief: carryOverBrief(carry, merge?.merged ?? false, merge?.conflicted), findings: carry.findings, ...(carry.round != null ? { round: carry.round } : {}) };
}
