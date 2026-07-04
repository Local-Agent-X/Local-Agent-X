/**
 * Per-chunk build + persistence for the parallel-wave engine (S3). Split out of
 * parallel-waves.ts (which keeps the wave/batch ORCHESTRATION) so each file owns
 * one responsibility: this one takes a single DispatchedChunk and (a) builds it
 * inside its isolated worktree, (b) commits its work for merge-back on success,
 * or (c) preserves its work on a halt so nothing is destroyed on teardown.
 *
 * The shared shapes (ParallelWavesContext / DispatchedChunk / BuiltChunk) live
 * in parallel-waves.ts and are imported here TYPE-ONLY — erased at compile, so
 * there is no runtime import cycle (parallel-waves imports these functions; this
 * file imports only their types back).
 */

import { getHeadSha } from "../git-helpers.js";
import { applyAdditiveSpecAmendment } from "../loop-effects.js";
import { commitInWorktree } from "../../agency/worktree.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { handlePushBack } from "./handle-push-back.js";
import { safeGet } from "./types.js";
import type { ParallelWavesContext, DispatchedChunk, BuiltChunk } from "./parallel-waves.js";

/**
 * Build one chunk inside its own worktree (projectDir = worktree). Mirrors the
 * serial runChunkOnce + push_back handling, scoped to the worktree so its
 * build-exec gate builds/tests in isolation. Phase-gate auto-recovery is
 * intentionally omitted (see parallel-waves header). Returns the resolved action.
 */
export async function buildChunkInWorktree(ctx: ParallelWavesContext, d: DispatchedChunk): Promise<BuiltChunk> {
  const { opts, totalChunks, emit, outcomes } = ctx;

  const preSha = await safeGet(() => getHeadSha(d.worktreePath));
  const preShaVal = preSha.ok ? preSha.value : "";

  emit({
    type: "chunk-start", chunkNumber: d.chunk.number, totalChunks,
    message: `Starting chunk ${d.chunk.number}/${totalChunks} in worktree ${d.name} (worker ${d.workerIndex}): ${d.chunk.title} (${d.chunk.klass})`,
  });

  const outcome = await runChunkOnce({
    chunk: d.chunk, totalChunks,
    planPath: opts.planPath, plan: opts.plan,
    projectDir: d.worktreePath,           // isolated worktree, NOT the base tree
    preSha: preShaVal,
    subprocessTimeoutMs: opts.subprocessTimeoutMs,
    signal: opts.signal, emit,
    retryReason: undefined,
    judgmentHook: opts.judgmentHook,
    parentSessionId: opts.parentSessionId, parentOpId: opts.parentOpId, // nest card under orchestrator
    priorOutcomes: outcomes,              // learnings from already-merged chunks
    workerIndex: d.workerIndex,           // unique per concurrent build (S5 ports)
  });

  let finalOutcome = outcome;
  let finalAction = outcome.action;

  if (outcome.action === "push_back") {
    const pb = await handlePushBack({
      chunk: d.chunk, totalChunks,
      planPath: opts.planPath, plan: opts.plan,
      projectDir: d.worktreePath, preSha: preShaVal,
      subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
      judgmentHook: opts.judgmentHook, parentOpId: opts.parentOpId,
      outcome,
    });
    finalOutcome = pb.finalOutcome;
    finalAction = pb.finalAction;
  }

  return { dispatched: d, chunk: d.chunk, finalOutcome, finalAction };
}

/**
 * Commit a proceed/amend_spec chunk's work INSIDE its worktree so mergeWorktree
 * can fast-forward it into base. For amend_spec, the additive spec text is
 * applied into the worktree first and committed with the code. The launch-
 * readiness FILE is deliberately not written (see header); surfaced as an event.
 */
export async function commitDispatchedChunk(ctx: ParallelWavesContext, r: BuiltChunk): Promise<void> {
  const { totalChunks, emit } = ctx;
  const d = r.dispatched;

  if (r.finalAction === "amend_spec" && r.finalOutcome.report.specGaps) {
    const amend = await applyAdditiveSpecAmendment(d.worktreePath, r.chunk, r.finalOutcome.report.specGaps);
    if (amend.ok) {
      emit({
        type: "spec-amended", chunkNumber: r.chunk.number, totalChunks,
        message: `Spec amended additively in worktree ${d.name}: ${amend.value.appendedTo}`,
        data: { appendedTo: amend.value.appendedTo, bytes: amend.value.bytesAppended },
      });
    }
  }

  let sha: string | null = null;
  try {
    sha = commitInWorktree(d.name, `chunk ${r.chunk.number}: ${r.chunk.title}`);
  } catch {
    // commitInWorktree throws only if the worktree vanished; the subsequent
    // mergeWorktree will surface that as a merge failure and halt.
  }
  emit({
    type: "commit", chunkNumber: r.chunk.number, totalChunks,
    message: `Committed chunk ${r.chunk.number} in worktree ${d.name}${sha ? ` (sha ${sha.slice(0, 8)})` : " (no file changes)"}`,
  });

  if (r.finalOutcome.report.launchReadiness) {
    emit({
      type: "launch-readiness-emitted", chunkNumber: r.chunk.number, totalChunks,
      message: `Launch-readiness item recorded (event only in the parallel path).`,
      data: { item: r.finalOutcome.report.launchReadiness.slice(0, 200) },
    });
  }
}

/**
 * Commit one dispatched chunk's WRITTEN work onto its branch before a pre-merge
 * halt tears the worktree down. cleanupWorktree keeps an unmerged branch, but
 * `git worktree remove --force` deletes the working dir with any UNCOMMITTED
 * files — and the pre-merge halt path has committed nothing yet, so without this
 * the preserved branch is empty and the agent's work is lost. Best-effort: a
 * commit failure (worktree vanished) or a clean tree (chunk wrote nothing) must
 * not mask the real halt. Returns true only when a non-empty commit was made.
 */
export function preserveWorktreeWork(ctx: ParallelWavesContext, d: DispatchedChunk): boolean {
  const { emit, totalChunks } = ctx;
  let sha: string | null = null;
  try {
    sha = commitInWorktree(d.name, `chunk ${d.chunk.number} (preserved on halt): ${d.chunk.title}`);
  } catch {
    return false; // worktree gone — nothing to preserve
  }
  if (!sha) return false; // clean tree — the chunk wrote nothing
  emit({
    type: "commit", chunkNumber: d.chunk.number, totalChunks,
    message: `Preserved chunk ${d.chunk.number}'s work on branch '${d.branch}' before halt (sha ${sha.slice(0, 8)}) — recover with: git checkout ${d.branch}`,
  });
  return true;
}
