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
 * A chunk that is still not green after its fix rounds does NOT stop the build:
 * it is set aside with its work kept on its branch, the chunks that passed
 * merge, and later waves build everything that does not depend on it
 * (set-aside.ts). The run then ends halted, saying what landed, what was set
 * aside and what waits. The two stops below are different: they mean the base
 * itself can no longer be trusted.
 *
 * (2) A CONFLICT IN CODE IS NEVER RESOLVED HERE. A chunk whose merge conflicts
 *     is set aside with its branch PRESERVED, named in the run's summary; the
 *     chunks after it still merge, since a failed merge is aborted in its own
 *     worktree and leaves the base as it was. The one exception is the files
 *     every chunk edits (ARCHITECTURE.md, the generated map, package.json and
 *     its lockfile when chunks each add packages): those are settled
 *     by rule (shared-file-merge.ts) and judged by the re-gate. Silent
 *     corruption is the one unacceptable outcome.
 * (3) RE-GATE THE MERGED TREE (S4). Rule 2 catches TEXTUAL conflicts only; a
 *     textually-clean merge can still be SEMANTICALLY broken (same-wave siblings
 *     build in disjoint worktrees, so their COMBINED tree is never built by any
 *     one worktree). After each wave's merge-back completes we run the existing
 *     build-exec gate ONCE on the merged base (loop/merged-regate) and HALT
 *     before the next wave if it fails. See merged-regate.ts.
 *
 * Differences from the serial path (documented, safe): a phase's verification
 * gate is scored once every chunk of the phase has merged, on the merged base,
 * between waves (loop/phase-gate-pause.ts), not right after the chunk that
 * closes it; LAUNCH_READINESS.md is NOT written into each worktree (concurrent
 * appends to that shared file would collide on merge-back), surfaced via event +
 * chunk outcome (the source of truth) instead.
 */

import { planWaves } from "../conflict-graph.js";
import { getHeadSha } from "../git-helpers.js";
import { appendHalt, clearSetAside, recordSetAside } from "../failure-recovery.js";
import { emitLaunchReadiness } from "../loop-effects.js";
import { createNamedWorktree, mergeWorktree, cleanupWorktree } from "../../agency/worktree.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { buildChunkWithRetry } from "./chunk-attempt.js";
import { createPhasePauseTracker, type PhasePauseTracker } from "./phase-gate-pause.js";
import { isPhaseGatePause } from "../chunk-review/index.js";
import { handleAction } from "./handle-action.js";
import { reGateMergedTree, warnFootprintEscapes } from "./merged-regate.js";
import { anythingSetAside, createSetAsideLedger, endWithSetAside, holdBackWaiting, MAX_SET_ASIDE, type SetAsideLedger } from "./set-aside.js";
import { createSharedFileMerge, regenerateSharedFiles, relockMergedProject, type SharedFileMerge } from "./shared-file-merge.js";
import { buildChunkInWorktree, commitDispatchedChunk, preserveWorktreeWork } from "./parallel-chunk-build.js";
import { copyLocalFiles } from "./worktree-local-files.js";
import { pickUpSetAsideWork } from "./carry-over.js";
import { isSetAsideCase, setChunkAsideInTree } from "./tree-set-aside.js";
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
/** The run's own state beside the shared context: which phases paused at
 *  their verification gate and wait for all their chunks to land. */
type RunContext = ParallelWavesContext & {
  phasePauses: PhasePauseTracker;
  /** Chunks set aside this run, and the ones left waiting on them. */
  ledger: SetAsideLedger;
  /** Chunks merged into base this run, in landing order. */
  landedThisRun: number[];
  /** Settles merge conflicts in the files every chunk edits. */
  sharedMerge: SharedFileMerge;
};

const endRunWithSetAside = (ctx: RunContext, chunksCommitted: number): LoopResult =>
  endWithSetAside(ctx.ledger, ctx.landedThisRun, { ...ctx, chunksCommitted });

export async function runParallelWaves(input: ParallelWavesContext): Promise<LoopResult> {
  const { opts, totalChunks, maxConcurrentChunks, emit, events, outcomes } = input;
  // The run builds a window of the plan. The chunks before it have landed, and
  // so have the ones inside it an earlier run landed past a chunk it set aside.
  const already = new Set(opts.landedChunks ?? []);
  const chunks = input.chunks.filter((c) => !already.has(c.number));
  const windowStart = Math.max(0, opts.plan.chunks.indexOf(input.chunks[0]));
  const landedBefore = [...opts.plan.chunks.slice(0, windowStart), ...input.chunks.filter((c) => already.has(c.number))].map((c) => c.number);
  if (chunks.length === 0) {
    const last = input.chunks[input.chunks.length - 1].number;
    emit({ type: "complete", chunkNumber: last, totalChunks, message: "Loop complete (parallel): every chunk in scope had already landed." });
    return { status: "complete", lastChunk: last, chunksCommitted: 0, haltReason: "", outcomes, events };
  }
  const ctx: RunContext = { ...input, chunks, phasePauses: createPhasePauseTracker(chunks), ledger: createSetAsideLedger(), landedThisRun: [], sharedMerge: createSharedFileMerge() };
  const waves = planWaves(chunks, landedBefore);
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
      // A chunk that depends on one that did not land is not started.
      const { buildable, held } = holdBackWaiting(ctx.ledger, wave.chunks.slice(b, b + maxConcurrentChunks));
      for (const w of held) {
        emit({ type: "chunk-set-aside", chunkNumber: w.chunk, totalChunks, message: `Chunk ${w.chunk} not started: it depends on chunk ${w.on}, which did not land.` });
      }
      if (buildable.length === 0) continue;
      const step = await runBatch(ctx, buildable, chunksCommitted);
      if (step.kind === "halt") return step.result;
      chunksCommitted = step.chunksCommitted;
      if (ctx.ledger.setAside.length >= MAX_SET_ASIDE) return endRunWithSetAside(ctx, chunksCommitted);
    }

    // S4 rule 3 — re-gate the now-fully-merged wave on base BEFORE cutting the
    // next wave's worktrees from it. Per-wave (not once at end) so a known-good
    // base seeds the next wave and the halt localizes which wave broke. Always
    // re-gate (even a 1-chunk wave — it no-ops cheaply without a build script).
    const regate = await reGateMergedTree({
      projectDir: opts.projectDir, signal: opts.signal, totalChunks,
      waveIndex: w, lastChunkNumber: wave.chunks[wave.chunks.length - 1].number,
      chunksCommitted, emit, events, outcomes, opId: opts.parentOpId ?? `auto-build:${opts.projectDir}`,
    });
    if (regate.kind === "halt") return regate.result;

    // A phase whose chunks have all landed is scored on the merged base now,
    // before the next wave builds on it (phase-gate-pause.ts).
    const phase = await ctx.phasePauses.scoreFinished(ctx, chunksCommitted);
    if (phase.kind === "halt") return phase.result;
  }

  if (anythingSetAside(ctx.ledger)) return endRunWithSetAside(ctx, chunksCommitted);
  const lastChunk = chunks[chunks.length - 1].number;
  emit({ type: "complete", chunkNumber: lastChunk, totalChunks, message: `Loop complete (parallel): ${chunksCommitted} chunks committed.` });
  return { status: "complete", lastChunk, chunksCommitted, haltReason: "", outcomes, events };
}

/** Build one batch (≤ maxConcurrentChunks disjoint chunks) concurrently, then
 *  merge them back SERIALLY. Enforces rules 1 + 2 (rule 3 re-gate is per-wave). */
async function runBatch(ctx: RunContext, batch: ParsedChunk[], chunksCommittedIn: number): Promise<StepResult> {
  const { opts, totalChunks, emit, events, outcomes } = ctx;
  let chunksCommitted = chunksCommittedIn;

  // 1. Create one worktree per chunk. A null return (cap reached, or git refused) does
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
    const buildRunId = `${opts.parentOpId ?? opts.parentSessionId ?? opts.planPath}:chunk:${chunk.number}`;
    const wt = createNamedWorktree(name, branch, opts.projectDir, buildRunId);
    if (!wt) {
      emit({
        type: "review-result", chunkNumber: chunk.number, totalChunks,
        message: `Worktree unavailable for chunk ${chunk.number} (the worktree cap was reached or creating it failed; the server log says which) — will build it serially on base after the parallel batch.`,
      });
      degradedToSerial.push(chunk);
      continue;
    }
    // Record the branch createNamedWorktree ACTUALLY cut, not the one requested:
    // an unmerged `autobuild/c<N>` leftover from a previous run is preserved and
    // this run side-steps to `autobuild/c<N>-2`. Git ops go by `name`, but every
    // "git checkout <branch>" recovery hint reads this field.
    dispatched.push({ chunk, name, branch: wt.branch, worktreePath: wt.path, workerIndex: workerIndex++ });
    // Git gave the worktree the tracked files; the project's ignored config
    // (an env file, a service config) comes across here (worktree-local-files.ts).
    const local = copyLocalFiles(opts.projectDir, wt.path);
    if (local.length > 0) {
      emit({
        type: "review-result", chunkNumber: chunk.number, totalChunks,
        message: `Chunk ${chunk.number}'s worktree got the project's ${local.length} git-ignored local file(s): ${local.slice(0, 8).join(", ")}${local.length > 8 ? ", …" : ""}.`,
      });
    }
  }

  // Wrap everything past worktree creation: ANY throw cleans up every worktree
  // this batch created before propagating, else a rejected Promise.all leaks the
  // registry slots (global cap 12) + temp dirs. Normal `return`s clean up precisely.
  try {
    // 2. DISPATCH all worktree chunks CONCURRENTLY — each in its own worktree.
    const built = await Promise.all(dispatched.map(d => buildChunkInWorktree(ctx, d)));

    // Record every dispatched chunk's outcome for the punch list (order preserved).
    for (const r of built) outcomes.push({ chunkNumber: r.chunk.number, outcome: r.finalOutcome, action: r.finalAction });

    // 3. A dispatched chunk that did not reach proceed/amend_spec is SET ASIDE:
    //    its written work is committed onto its branch FIRST (cleanupWorktree
    //    keeps an unmerged branch, but `git worktree remove --force` deletes
    //    the working dir with any UNCOMMITTED files, and nothing has been
    //    committed yet on this path), then its worktree is torn down. The
    //    chunks that passed merge below; the build goes on without this one.
    // A chunk paused at its phase's gate was accepted: it merges like the rest.
    const passed = built.filter(r => r.finalAction === "proceed" || r.finalAction === "amend_spec" || isPhaseGatePause(r.finalOutcome));
    for (const r of built) if (!passed.includes(r)) setChunkAside(ctx, r);

    // 4. Commit each chunk that passed inside its worktree, then MERGE BACK
    //    ONE AT A TIME (rule 1 — strictly sequential).
    for (const r of passed) await commitDispatchedChunk(ctx, r);

    for (const r of passed) {                      // SERIAL merge loop — never Promise.all.
      const d = r.dispatched;
      // Re-reads base tip + fast-forward-advances it. A conflict confined to
      // the files every chunk edits is settled by rule (shared-file-merge.ts).
      const res = mergeWorktree(d.name, { resolveConflicts: ctx.sharedMerge.resolver });
      if (!res.merged) {
        // Rule 2: never resolved here. mergeWorktree aborted the merge in the
        // chunk's worktree and kept its branch; base is as it was, so the
        // chunks after this one still merge.
        setAsideUnmerged(ctx, d, res.error);
        continue;
      }
      chunksCommitted++;
      ctx.landedThisRun.push(d.chunk.number);
      clearSetAside(opts.projectDir, d.chunk.number);
      ctx.phasePauses.landed(r.chunk, r.finalOutcome);
      emit({ type: "commit", chunkNumber: d.chunk.number, totalChunks, message: `Merged chunk ${d.chunk.number} back to base (${res.files} file(s) from '${d.branch}').` });
      emit({
        type: "chunk-landed", chunkNumber: d.chunk.number, totalChunks,
        message: `Chunk ${d.chunk.number} landed in the base project after worktree merge.`,
      });

      // S4 footprint-subset DIAGNOSTIC — warn (never halt) if this chunk's ACTUAL
      // changed files escaped its DECLARED footprint (the latent cause of a real
      // parallel conflict). Empty/undeclared footprint never warns.
      warnFootprintEscapes({ chunk: d.chunk, changed: r.finalOutcome.report.changed, totalChunks, emit });
    }
    await regenerateAfterMerges(ctx, batch[batch.length - 1].number);
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

/** What a batch's merges settled by taking the base's copy is one batch
 *  behind: produce it again from the merged project before the re-gate builds
 *  it. The generated map, and the lockfile of a package.json two chunks both
 *  added packages to (shared-file-merge.ts). */
async function regenerateAfterMerges(ctx: RunContext, chunkNumber: number): Promise<void> {
  const { opts, totalChunks, emit } = ctx;
  if (ctx.sharedMerge.mapIsStale()) {
    const regenerated = await regenerateSharedFiles(opts.projectDir, opts.signal);
    ctx.sharedMerge.mapRegenerated();
    emit({
      type: "review-result", chunkNumber, totalChunks,
      message: regenerated.ok
        ? `Codebase map after the merged batch: ${regenerated.detail}.`
        : `WARNING: the codebase map could not be regenerated after the merged batch (${regenerated.detail}); the re-gate will say whether it is stale.`,
    });
  }
  const lockfiles = ctx.sharedMerge.staleLockfiles();
  if (lockfiles.length === 0) return;
  const relocked = await relockMergedProject(opts.projectDir, lockfiles, opts.parentOpId ?? `auto-build:${opts.projectDir}`, opts.signal);
  ctx.sharedMerge.lockfilesRewritten();
  for (const r of relocked) {
    emit({
      type: "review-result", chunkNumber, totalChunks,
      message: r.ok
        ? `${r.lockfile} after the merged batch, which added packages in more than one chunk: ${r.detail}.`
        : `WARNING: ${r.lockfile} could not be written again after the merged batch (${r.detail}); it names only some of the packages package.json does, so the re-gate's build may not find the rest.`,
    });
  }
}

/**
 * Worktree-cap fallback: build one chunk SERIALLY on the base tree, reusing the
 * serial-path primitives (buildChunkWithRetry + handleAction).
 */
async function buildChunkOnBaseSerial(ctx: RunContext, chunk: ParsedChunk, chunksCommittedIn: number): Promise<StepResult> {
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

  const carryOver = pickUpSetAsideWork({ projectDir: opts.projectDir, tree: opts.projectDir, chunk, totalChunks, emit });
  const { finalOutcome, finalAction } = await buildChunkWithRetry({
    opts, chunk, totalChunks, emit, preSha: preSha.value, priorOutcomes: outcomes,
    ...(carryOver ? { carryOver } : {}),
  });

  outcomes.push({ chunkNumber: chunk.number, outcome: finalOutcome, action: finalAction });
  // A phase pause lands like a proceed; the phase is scored once the wave is in.
  const paused = isPhaseGatePause(finalOutcome);
  // Still not green: set aside like a chunk built in a worktree, its work
  // moved out of the base tree onto a branch (tree-set-aside.ts).
  if (isSetAsideCase(finalAction, paused, opts.signal)
    && setChunkAsideInTree({ projectDir: opts.projectDir, chunk, totalChunks, preSha: preSha.value, outcome: finalOutcome, ledger: ctx.ledger, emit })) {
    return { kind: "advance", chunksCommitted };
  }
  if (finalOutcome.report.launchReadiness) {
    emitLaunchReadiness(opts.projectDir, chunk, finalOutcome.report.launchReadiness);
  }

  const handled = await handleAction({
    chunk, totalChunks, projectDir: opts.projectDir,
    finalAction: paused ? "proceed" : finalAction, finalOutcome, chunksCommitted, outcomes, events, emit,
  });
  if (handled.kind === "halt") return { kind: "halt", result: handled.result };
  ctx.landedThisRun.push(chunk.number);
  clearSetAside(opts.projectDir, chunk.number);
  ctx.phasePauses.landed(chunk, finalOutcome);
  return { kind: "advance", chunksCommitted: handled.chunksCommitted };
}

/** Set one dispatched chunk aside: keep its work on its branch, free its
 *  worktree, and put it on the run's ledger with the review's reason. */
function setChunkAside(ctx: RunContext, r: BuiltChunk): void {
  const { opts, totalChunks, emit } = ctx;
  const d = r.dispatched;
  const kept = preserveWorktreeWork(ctx, d);
  cleanupWorktreeSafe(d.name);
  const reason = r.finalOutcome.reasoning;
  ctx.ledger.setAside.push({ chunk: d.chunk.number, title: d.chunk.title, reason, ...(kept ? { branch: d.branch } : {}) });
  emit({
    type: "chunk-set-aside", chunkNumber: d.chunk.number, totalChunks,
    message: `Chunk ${d.chunk.number} set aside, the build goes on without it: ${reason.replace(/\s+/g, " ").slice(0, 300)}${kept ? ` Work kept on branch '${d.branch}'.` : ""}`,
  });
  const gate = r.finalOutcome.findings.find(f => f.action === "halt" || f.action === "push_back")?.gate || "";
  appendHalt(opts.projectDir, { chunk: d.chunk.number, gate, reason: reason.slice(0, 200) });
  recordSetAside(opts.projectDir, d.chunk.number, kept ? d.branch : undefined, reason);
}

/** Set aside a chunk that passed its review but whose work could not be merged
 *  with what landed before it. mergeWorktree has already kept its branch. */
function setAsideUnmerged(ctx: RunContext, d: DispatchedChunk, error: string | undefined): void {
  const { opts, totalChunks, emit } = ctx;
  const reason = `It passed its review, but its work could not be merged with what landed before it. ${error || ""}`.trim();
  ctx.ledger.setAside.push({ chunk: d.chunk.number, title: d.chunk.title, reason, branch: d.branch });
  emit({
    type: "chunk-set-aside", chunkNumber: d.chunk.number, totalChunks,
    message: `Chunk ${d.chunk.number} set aside, the build goes on without it: ${reason.replace(/\s+/g, " ").slice(0, 300)} Work kept on branch '${d.branch}'.`,
  });
  appendHalt(opts.projectDir, { chunk: d.chunk.number, gate: "worktree-merge", reason: reason.slice(0, 200) });
  recordSetAside(opts.projectDir, d.chunk.number, d.branch, reason);
}

/** cleanupWorktree, guarded — never let a cleanup error mask the real halt. */
function cleanupWorktreeSafe(name: string): void {
  try { cleanupWorktree(name); } catch { /* best-effort teardown */ }
}
