/**
 * Parallel-wave orchestration for auto-build (S3) — the OPT-IN concurrent path.
 *
 * The serial per-chunk loop in run.ts is the default and is UNCHANGED; this
 * file is only reached when maxConcurrentChunks > 1. It builds disjoint chunks
 * concurrently in isolated git worktrees, then integrates their work back into
 * the shared base branch.
 *
 * Model:
 *   waves = planWaves(windowedChunks)        // conflict-graph (S2), pure
 *   for each wave:                           // waves run STRICTLY in sequence
 *     for each batch of <= maxConcurrentChunks chunks in the wave:
 *       1. create one isolated worktree per chunk (createNamedWorktree)
 *       2. DISPATCH all chunk agents CONCURRENTLY, each with projectDir = its
 *          own worktree + a unique workerIndex (Promise.all)
 *       3. MERGE the worktrees back into base ONE AT A TIME (rule 1)
 * A later-wave chunk that dependsOn an earlier chunk sees that work because we
 * merge every wave back into base BEFORE creating the next wave's worktrees
 * (they branch from the freshly-advanced base).
 *
 * ── THE THREE NON-NEGOTIABLE CORRECTNESS RULES ──────────────────────────────
 * (1) BUILDS PARALLEL, MERGE-BACK SERIAL. mergeWorktree() re-reads the base tip
 *     and fast-forward-advances it; interleaving two merges corrupts the base
 *     pointer and silently drops commits. So the merge loop is a plain
 *     sequential `for` that awaits nothing concurrently — NEVER Promise.all.
 * (2) HALT ON CONFLICT — never auto-resolve. If any mergeWorktree returns
 *     {merged:false} we STOP the whole build (no next wave), surface a clear
 *     error naming the chunk + its PRESERVED branch, and clean up the other
 *     worktrees. Silent corruption is the one unacceptable outcome.
 * (3) RE-GATE THE MERGED TREE (S4). Rule 2 catches TEXTUAL conflicts only; a
 *     textually-clean merge can still be SEMANTICALLY broken (same-wave siblings
 *     build in disjoint worktrees, so their COMBINED tree is never built by any
 *     one worktree). After each wave's merge-back completes we run the existing
 *     build-exec gate ONCE on the merged base (loop/merged-regate) and HALT
 *     before the next wave if it fails. See merged-regate.ts.
 *
 * Differences from the serial path (documented, safe): per-chunk phase-gate
 * auto-scoring recovery is NOT run here (it allocates a dev-server port and
 * running it concurrently risks collisions — a phase-gate halt is treated as a
 * plain halt); LAUNCH_READINESS.md is NOT written into each worktree (concurrent
 * appends to that shared file would collide on merge-back), surfaced via event +
 * chunk outcome (the source of truth) instead.
 */

import { planWaves } from "../conflict-graph.js";
import { getHeadSha } from "../git-helpers.js";
import { appendHalt } from "../failure-recovery.js";
import { emitLaunchReadiness } from "../loop-effects.js";
import { createNamedWorktree, mergeWorktree, cleanupWorktree } from "../../agency/worktree.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { handlePushBack } from "./handle-push-back.js";
import { handleAction } from "./handle-action.js";
import { reGateMergedTree, warnFootprintEscapes } from "./merged-regate.js";
import { buildChunkInWorktree, commitDispatchedChunk, preserveWorktreeWork } from "./parallel-chunk-build.js";
import type { EmitFn, LoopEvent, LoopOptions, LoopResult } from "./types.js";
import { haltedResult, safeGet } from "./types.js";

export interface ParallelWavesContext {
  opts: LoopOptions;
  /** Windowed chunk slice [startIdx, endIdx) — the chunks this run will build. */
  chunks: ParsedChunk[];
  totalChunks: number;
  /** Already clamped to [1,12] by the caller. */
  maxConcurrentChunks: number;
  emit: EmitFn;
  events: LoopEvent[];
  /** Shared, mutated in place — the running punch-list of per-chunk outcomes. */
  outcomes: LoopResult["outcomes"];
}

/** A chunk that got its own worktree and will build in parallel. */
export interface DispatchedChunk {
  chunk: ParsedChunk;
  /** Worktree registry key — same key passed to mergeWorktree/cleanupWorktree. */
  name: string;
  branch: string;
  worktreePath: string;
  /** Unique 0-based index within the concurrently-dispatched batch (S5 ports). */
  workerIndex: number;
}

/** The result of building one dispatched chunk in its worktree. */
export interface BuiltChunk {
  dispatched: DispatchedChunk;
  chunk: ParsedChunk;
  finalOutcome: ChunkReviewOutcome;
  finalAction: ReviewAction;
}

type StepResult =
  | { kind: "halt"; result: LoopResult }
  | { kind: "advance"; chunksCommitted: number };

/**
 * Run the whole build via the parallel-wave engine. Returns a LoopResult with
 * the same shape as the serial path so the caller (run.ts / the orchestrator)
 * is agnostic to which path ran.
 */
export async function runParallelWaves(ctx: ParallelWavesContext): Promise<LoopResult> {
  const { opts, chunks, totalChunks, maxConcurrentChunks, emit, events, outcomes } = ctx;
  const waves = planWaves(chunks);
  let chunksCommitted = 0;

  emit({
    type: "review-result", chunkNumber: chunks[0].number, totalChunks,
    message: `Parallel build engaged: ${chunks.length} chunk(s) in ${waves.length} wave(s), up to ${maxConcurrentChunks} concurrent per batch.`,
  });

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    if (opts.signal?.aborted) {
      return haltedResult("loop aborted by signal", wave.chunks[0].number, outcomes, events);
    }
    if (wave.degraded) {
      emit({
        type: "review-result", chunkNumber: wave.chunks[0].number, totalChunks,
        message: `Wave DEGRADED — a dependency cycle / missing dep was force-broken; chunk ${wave.chunks[0].number} is serialized alone and its dependency ordering is NOT guaranteed.`,
      });
    }

    // Cap concurrency at maxConcurrentChunks by processing the wave in batches.
    // Waves already carry only footprint-disjoint chunks (conflict-graph), so
    // splitting one into sequential batches is always safe.
    for (let b = 0; b < wave.chunks.length; b += maxConcurrentChunks) {
      const batch = wave.chunks.slice(b, b + maxConcurrentChunks);
      const step = await runBatch(ctx, batch, chunksCommitted);
      if (step.kind === "halt") return step.result;
      chunksCommitted = step.chunksCommitted;
    }

    // S4 rule 3 — re-gate the now-fully-merged wave on base BEFORE cutting the
    // next wave's worktrees from it. Per-wave (not once at end) so a known-good
    // base seeds the next wave and the halt localizes which wave broke. Always
    // re-gate (even a 1-chunk wave — it no-ops cheaply without a build script).
    const regate = await reGateMergedTree({
      projectDir: opts.projectDir, signal: opts.signal, totalChunks,
      waveIndex: w, lastChunkNumber: wave.chunks[wave.chunks.length - 1].number,
      chunksCommitted, emit, events, outcomes,
    });
    if (regate.kind === "halt") return regate.result;
  }

  const lastChunk = chunks[chunks.length - 1].number;
  emit({ type: "complete", chunkNumber: lastChunk, totalChunks, message: `Loop complete (parallel): ${chunksCommitted} chunks committed.` });
  return { status: "complete", lastChunk, chunksCommitted, haltReason: "", outcomes, events };
}

/** Build one batch (≤ maxConcurrentChunks disjoint chunks) concurrently, then
 *  merge them back SERIALLY. Enforces rules 1 + 2 (rule 3 re-gate is per-wave). */
async function runBatch(ctx: ParallelWavesContext, batch: ParsedChunk[], chunksCommittedIn: number): Promise<StepResult> {
  const { opts, totalChunks, emit, events, outcomes } = ctx;
  let chunksCommitted = chunksCommittedIn;

  // 1. Create one worktree per chunk. A null return (worktree cap reached) does
  //    NOT crash: that chunk falls back to a SERIAL build on base after this
  //    batch merges. workerIndex is assigned only to chunks that got a worktree.
  const dispatched: DispatchedChunk[] = [];
  const degradedToSerial: ParsedChunk[] = [];
  let workerIndex = 0;
  for (const chunk of batch) {
    const name = `autobuild-c${chunk.number}`;
    const branch = `autobuild/c${chunk.number}`;
    // Anchor the worktree to the USER's project repo (opts.projectDir), NOT the
    // LAX server's process.cwd() — a cwd-derived root would cut from LAX's repo.
    const wt = createNamedWorktree(name, branch, opts.projectDir);
    if (!wt) {
      emit({
        type: "review-result", chunkNumber: chunk.number, totalChunks,
        message: `Worktree unavailable for chunk ${chunk.number} (worktree cap reached) — will build it serially on base after the parallel batch.`,
      });
      degradedToSerial.push(chunk);
      continue;
    }
    dispatched.push({ chunk, name, branch, worktreePath: wt.path, workerIndex: workerIndex++ });
  }

  // Wrap everything past worktree creation: ANY throw cleans up every worktree
  // this batch created before propagating, else a rejected Promise.all leaks the
  // registry slots (global cap 12) + temp dirs. Normal `return`s clean up precisely.
  try {
    // 2. DISPATCH all worktree chunks CONCURRENTLY — each in its own worktree.
    const built = await Promise.all(dispatched.map(d => buildChunkInWorktree(ctx, d)));

    // Record every dispatched chunk's outcome for the punch list (order preserved).
    for (const r of built) outcomes.push({ chunkNumber: r.chunk.number, outcome: r.finalOutcome, action: r.finalAction });

    // 3. If ANY dispatched chunk did not reach proceed/amend_spec, HALT BEFORE
    //    merging anything (rule 2). Nothing is merged — but every dispatched
    //    chunk's WRITTEN work is committed onto its branch FIRST so the halt is
    //    recoverable. cleanupWorktree keeps an unmerged branch, yet
    //    `git worktree remove --force` deletes the working dir with any
    //    UNCOMMITTED files; on this pre-merge path nothing has been committed
    //    yet, so without this the "preserved" branch is empty and the agents'
    //    work — including any succeeded siblings' — is silently destroyed. A
    //    parallel halt must not lose more than a serial one (which leaves the
    //    work in the tree). Commit, THEN tear down.
    const failed = built.find(r => r.finalAction !== "proceed" && r.finalAction !== "amend_spec");
    if (failed) {
      const preserved: string[] = [];
      for (const d of dispatched) if (preserveWorktreeWork(ctx, d)) preserved.push(d.branch);
      for (const d of dispatched) cleanupWorktreeSafe(d.name);
      const gate = failed.finalOutcome.findings.find(f => f.action === "halt")?.gate || "";
      const recover = preserved.length
        ? ` Work preserved for recovery on branch(es): ${preserved.join(", ")} — git checkout <branch>.`
        : "";
      const reason = failed.finalOutcome.reasoning + recover;
      emit({ type: "halt", chunkNumber: failed.chunk.number, totalChunks, message: reason });
      appendHalt(opts.projectDir, { chunk: failed.chunk.number, gate, reason: reason.slice(0, 200) });
      return {
        kind: "halt",
        result: { status: "halted", lastChunk: failed.chunk.number, chunksCommitted, haltReason: reason, outcomes, events },
      };
    }

    // 4. All dispatched chunks reached proceed/amend_spec. Commit each inside its
    //    worktree, then MERGE BACK ONE AT A TIME (rule 1 — strictly sequential).
    for (const r of built) await commitDispatchedChunk(ctx, r);

    const merged = new Set<string>();
    for (const r of built) {                       // SERIAL merge loop — never Promise.all.
      const d = r.dispatched;
      const res = mergeWorktree(d.name);           // re-reads base tip + fast-forward-advances it
      merged.add(d.name);
      if (!res.merged) {
        // Rule 2: HALT. The conflicting branch is already preserved by
        // mergeWorktree; clean up only the worktrees we have NOT merged yet.
        for (const other of dispatched) if (!merged.has(other.name)) cleanupWorktreeSafe(other.name);
        const reason =
          `Chunk ${d.chunk.number} could not merge back cleanly — build HALTED to avoid silent corruption. ` +
          `Its work is preserved on branch '${d.branch}' for manual resolution. ${res.error || ""}`.trim();
        emit({ type: "halt", chunkNumber: d.chunk.number, totalChunks, message: reason });
        appendHalt(opts.projectDir, { chunk: d.chunk.number, gate: "worktree-merge", reason: reason.slice(0, 200) });
        return { kind: "halt", result: { status: "halted", lastChunk: d.chunk.number, chunksCommitted, haltReason: reason, outcomes, events } };
      }
      chunksCommitted++;
      emit({ type: "commit", chunkNumber: d.chunk.number, totalChunks, message: `Merged chunk ${d.chunk.number} back to base (${res.files} file(s) from '${d.branch}').` });

      // S4 footprint-subset DIAGNOSTIC — warn (never halt) if this chunk's ACTUAL
      // changed files escaped its DECLARED footprint (the latent cause of a real
      // parallel conflict). Empty/undeclared footprint never warns.
      warnFootprintEscapes({ chunk: d.chunk, changed: r.finalOutcome.report.changed, totalChunks, emit });
    }
  } catch (err) {
    // A genuine throw escaped the batch — reclaim every worktree it created
    // (idempotent: cleanupWorktreeSafe no-ops on an already-merged/cleaned
    // entry) so the slot cap isn't leaked, then rethrow to the crash handler.
    for (const d of dispatched) cleanupWorktreeSafe(d.name);
    throw err;
  }

  // 5. Worktree-cap fallbacks: build them SERIALLY on base now that the batch's
  //    parallel work is merged in (their footprints are disjoint from it).
  for (const chunk of degradedToSerial) {
    const step = await buildChunkOnBaseSerial(ctx, chunk, chunksCommitted);
    if (step.kind === "halt") return step;
    chunksCommitted = step.chunksCommitted;
  }

  return { kind: "advance", chunksCommitted };
}

/**
 * Worktree-cap fallback: build one chunk SERIALLY on the base tree, reusing the
 * serial-path primitives (runChunkOnce + handlePushBack + handleAction).
 */
async function buildChunkOnBaseSerial(ctx: ParallelWavesContext, chunk: ParsedChunk, chunksCommittedIn: number): Promise<StepResult> {
  const { opts, totalChunks, emit, events, outcomes } = ctx;
  let chunksCommitted = chunksCommittedIn;

  emit({
    type: "chunk-start", chunkNumber: chunk.number, totalChunks,
    message: `Starting chunk ${chunk.number}/${totalChunks} SERIALLY on base (worktree cap): ${chunk.title} (${chunk.klass})`,
  });

  const preSha = await safeGet(() => getHeadSha(opts.projectDir));
  if (!preSha.ok) {
    return { kind: "halt", result: haltedResult(`git rev-parse HEAD failed before chunk ${chunk.number}: ${preSha.error}`, chunk.number, outcomes, events) };
  }

  const outcome = await runChunkOnce({
    chunk, totalChunks,
    planPath: opts.planPath, plan: opts.plan,
    projectDir: opts.projectDir, preSha: preSha.value,
    subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
    retryReason: undefined,
    judgmentHook: opts.judgmentHook,
    parentSessionId: opts.parentSessionId, parentOpId: opts.parentOpId,
    priorOutcomes: outcomes,
  });

  let finalOutcome = outcome;
  let finalAction = outcome.action;
  if (outcome.action === "push_back") {
    const pb = await handlePushBack({
      chunk, totalChunks,
      planPath: opts.planPath, plan: opts.plan,
      projectDir: opts.projectDir, preSha: preSha.value,
      subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
      judgmentHook: opts.judgmentHook, parentOpId: opts.parentOpId, outcome,
    });
    finalOutcome = pb.finalOutcome;
    finalAction = pb.finalAction;
  }

  outcomes.push({ chunkNumber: chunk.number, outcome: finalOutcome, action: finalAction });
  if (finalOutcome.report.launchReadiness) {
    emitLaunchReadiness(opts.projectDir, chunk, finalOutcome.report.launchReadiness);
  }

  const handled = await handleAction({
    chunk, totalChunks, projectDir: opts.projectDir,
    finalAction, finalOutcome, chunksCommitted, outcomes, events, emit,
  });
  if (handled.kind === "halt") return { kind: "halt", result: handled.result };
  return { kind: "advance", chunksCommitted: handled.chunksCommitted };
}

/** cleanupWorktree, guarded — never let a cleanup error mask the real halt. */
function cleanupWorktreeSafe(name: string): void {
  try { cleanupWorktree(name); } catch { /* best-effort teardown */ }
}
