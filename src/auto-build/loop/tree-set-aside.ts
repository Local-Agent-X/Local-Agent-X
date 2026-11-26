/**
 * Setting a chunk aside when it was built in the project tree itself.
 *
 * A chunk built in its own worktree that is still not green is set aside and
 * the build goes on without it (set-aside.ts). A chunk built in the project
 * tree (the one-at-a-time path, and a parallel chunk that got no worktree)
 * halted the whole build instead: its unfinished work sat uncommitted in the
 * tree every later chunk builds in, so nothing could be built past it.
 *
 * Here that work is moved out of the way: committed, kept on a branch of its
 * own, and the tree put back to the commit the chunk started from. The build
 * then goes on with every chunk that does not depend on it, and the next run
 * picks the branch up (carry-over.ts), as on the parallel path.
 *
 * Only where the project is its own git repository. A project folder inside a
 * larger repository shares that repository's tree, and putting it back would
 * reach files that are not the project's: there the build halts as before.
 */
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { git, commitWithFallbackIdentity } from "../../agency/worktree-core.js";
import { resolveStaleBranchName } from "../../agency/worktree-lifecycle.js";
import { appendHalt, recordSetAside } from "../failure-recovery.js";
import type { SetAsideLedger } from "./set-aside.js";
import type { EmitFn, InTreeChunk } from "./types.js";

/**
 * Move everything the chunk did since `preSha` onto a branch and put the tree
 * back as it was. Returns the branch, or undefined when the chunk left nothing
 * behind. Throws when git refuses a step: the work is then still in the tree
 * or on the base branch, never lost.
 */
export function parkTreeWork(projectDir: string, chunk: Pick<ParsedChunk, "number" | "title">, preSha: string): string | undefined {
  if (git(["rev-parse", "--show-prefix"], projectDir) !== "") {
    throw new Error("the project is a folder inside a larger git repository, so its tree cannot be put back on its own");
  }
  if (git(["status", "--porcelain"], projectDir)) {
    git(["add", "-A"], projectDir);
    commitWithFallbackIdentity(["-m", `chunk ${chunk.number} (set aside): ${chunk.title}`], projectDir);
  }
  const head = git(["rev-parse", "HEAD"], projectDir);
  if (head === preSha) return undefined;
  const branch = resolveStaleBranchName(`autobuild/c${chunk.number}`, projectDir);
  git(["branch", branch, head], projectDir);
  // The branch holds the work now; only then is the base moved back off it.
  git(["reset", "--hard", preSha], projectDir);
  return branch;
}

/**
 * Keep a chunk that a pause, a quit or a crash stopped part-built in the
 * project tree: its work goes onto a branch and the tree back to where the
 * chunk started, and the record says the round it was on, so the next run
 * picks it up there (carry-over.ts). Before this the work sat uncommitted in
 * the tree and the next chunk's commit took it in (label-check-sol's fix 1013,
 * 2026-11-25). Returns what it did, in a line for the log.
 */
export function parkInTreeChunk(projectDir: string, inTree: InTreeChunk): string {
  let branch: string | undefined;
  let note = "";
  try {
    branch = parkTreeWork(projectDir, { number: inTree.chunk, title: inTree.title }, inTree.preSha);
  } catch (e) {
    // Its work stays in the tree, where the resumed worker finds it.
    note = ` Its work could not be moved (${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}) and is still in the project.`;
  }
  recordSetAside(projectDir, inTree.chunk, branch, inTree.findings, inTree.round);
  return `Chunk ${inTree.chunk} was stopped in fix round ${inTree.round}; ${branch ? `its work is kept on branch '${branch}'` : "it had no work to keep"}, and it goes on from there.${note}`;
}

/**
 * Whether the owner's stop (Pause, Cancel) cut this chunk off before it was
 * accepted. Such a chunk did not fail: the run ends stopped with the chunk
 * still on record as part-built, and nothing goes on the halt history, where
 * three stops would read as a fault that keeps recurring.
 */
export function stoppedMidChunk(action: ReviewAction, signal?: AbortSignal): boolean {
  return signal?.aborted === true && action !== "proceed" && action !== "amend_spec";
}

/**
 * Whether a chunk that ended with `action` is one to set aside: not accepted
 * (a pause at its phase's gate is an accepted chunk), and not stopped by the
 * user, whose cancel leaves the tree as it is.
 */
export function isSetAsideCase(action: ReviewAction, pausedAtPhaseGate: boolean, signal?: AbortSignal): boolean {
  return action !== "proceed" && action !== "amend_spec" && !pausedAtPhaseGate && !signal?.aborted;
}

export interface TreeSetAsideInput {
  projectDir: string;
  chunk: ParsedChunk;
  totalChunks: number;
  /** HEAD of the project before the chunk started. */
  preSha: string;
  /** The review that left the chunk not green. */
  outcome: ChunkReviewOutcome;
  ledger: SetAsideLedger;
  emit: EmitFn;
}

/**
 * Set aside a chunk built in the project tree: park its work, put it on the
 * run's ledger and on record for the next run. Returns false, with a line
 * saying why, when the work could not be parked: the caller halts, since the
 * tree still holds the unfinished chunk.
 */
export function setChunkAsideInTree(a: TreeSetAsideInput): boolean {
  const { projectDir, chunk, totalChunks, emit } = a;
  let branch: string | undefined;
  try {
    branch = parkTreeWork(projectDir, chunk, a.preSha);
  } catch (e) {
    emit({
      type: "review-result", chunkNumber: chunk.number, totalChunks,
      message: `Chunk ${chunk.number} could not be set aside (${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}); its unfinished work is still in the project, so the build stops here.`,
    });
    return false;
  }
  const reason = a.outcome.reasoning;
  a.ledger.setAside.push({ chunk: chunk.number, title: chunk.title, reason, ...(branch ? { branch } : {}) });
  emit({
    type: "chunk-set-aside", chunkNumber: chunk.number, totalChunks,
    message: `Chunk ${chunk.number} set aside, the build goes on without it: ${reason.replace(/\s+/g, " ").slice(0, 300)}${branch ? ` Work kept on branch '${branch}'.` : ""}`,
  });
  const gate = a.outcome.findings.find((f) => f.action === "halt" || f.action === "push_back")?.gate || "";
  appendHalt(projectDir, { chunk: chunk.number, gate, reason: reason.slice(0, 200) });
  recordSetAside(projectDir, chunk.number, branch, reason);
  return true;
}
