/**
 * Auto-build loop — orchestrates per-chunk spawn → review → commit.
 *
 * From the design memo's "Internal loop" section. For each chunk:
 *
 *   task     = buildChunkTask(chunk, sharpenedContext, retryReason?)
 *   result   = runChunkAgent({ role, task, … })   // canonical agent path
 *   specDiff = git diff <pre-sha> -- spec/
 *   review   = runChunkReview(chunk, plan, result.chunkReport, files git says changed, specDiff)
 *
 *   proceed     → commit; advance
 *   amend_spec  → apply additive spec edit; commit separately; advance
 *   push_back   → fixed round by round (handle-push-back.ts)
 *   halt        → the chunk is set aside and the build goes on without it
 *                 (tree-set-aside.ts); a phase gate that failed still stops
 *
 * The loop NEVER:
 *   - Auto-applies a non-additive spec amendment (the additive-diff gate
 *     halts before we get here, but defense in depth — we re-check.)
 *   - Auto-drives phase-gate scenarios (halts and asks user to drive).
 *   - Auto-pushes to a remote (commit only).
 *   - Retries a halted chunk a second time.
 */

import { getRuntimeConfig } from "../../config.js";
import { ensureGitBaseline, getHeadSha } from "../git-helpers.js";
import { runPreflightProbe } from "./preflight.js";
import { attemptPhaseGateScoring } from "../loop-phase-gate.js";
import { emitLaunchReadiness } from "../loop-effects.js";
import type { EmitFn, LoopEvent, LoopOptions, LoopResult } from "./types.js";
import { haltedResult, safeGet } from "./types.js";
import { buildChunkWithRetry, type ChunkAttemptResult } from "./chunk-attempt.js";
import type { ParsedChunk } from "../plan-parser.js";
import { recordLanded, recordOwed } from "../failure-recovery.js";
import { pickUpSetAsideWork } from "./carry-over.js";
import { pruneMergedAgentBranches } from "../../agency/worktree-junctions.js";
import { anythingSetAside, createSetAsideLedger, endWithSetAside, holdBackWaiting, stopForSetAside, type SetAsideLedger } from "./set-aside.js";
import { isSetAsideCase, setChunkAsideInTree, stoppedMidChunk } from "./tree-set-aside.js";
import { isPhaseGatePause } from "../chunk-review/index.js";
import { handleAction } from "./handle-action.js";
import { createPhasePauseTracker } from "./phase-gate-pause.js";
import { createWallProbe } from "./wall-probe.js";
import { runFinishGates } from "../finish-gates/run.js";
import { runParallelWaves } from "./parallel-waves.js";
import { buildSplitOffs } from "./split-chunks.js";

/**
 * Resolve the effective parallel-chunk concurrency. An explicit
 * opts.maxConcurrentChunks (tests / callers) wins; otherwise the config value
 * is read here. Clamped to [1,12] defensively so an out-of-band override can
 * never exceed the worktree cap. 1 → the serial loop below (unchanged).
 */
function resolveMaxConcurrentChunks(override?: number): number {
  const raw = override ?? getRuntimeConfig().maxConcurrentChunks;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(12, n);
}

export async function runBuildLoop(opts: LoopOptions): Promise<LoopResult> {
  const startedAt = Date.now();
  const events: LoopEvent[] = [];
  const outcomes: LoopResult["outcomes"] = [];

  const emit = (e: Omit<LoopEvent, "elapsedMs">) => {
    const event: LoopEvent = { ...e, elapsedMs: Date.now() - startedAt };
    events.push(event);
    try { opts.onEvent?.(event); } catch { /* event sink must not crash the loop */ }
  };

  const chunks = opts.plan.chunks;
  const totalChunks = chunks.length;
  const startIdx = chunks.findIndex(c => c.number === opts.startingChunk);
  if (startIdx < 0) {
    return haltedResult(`starting_chunk=${opts.startingChunk} not found in plan (plan has ${totalChunks} chunks)`, 0, outcomes, events);
  }

  // The loop's rollback/diff machinery needs a git baseline. Establish it
  // rather than assuming it — a fresh finalize_app_build project has no repo.
  const baseline = await safeGet(() => ensureGitBaseline(opts.projectDir));
  if (!baseline.ok) {
    return haltedResult(`could not establish git baseline in ${opts.projectDir}: ${baseline.error}`, chunks[startIdx].number, outcomes, events);
  }
  if (baseline.value.initialized || baseline.value.committed) {
    emit({
      type: "git-baseline", chunkNumber: chunks[startIdx].number, totalChunks,
      message: baseline.value.initialized
        ? `Initialized git repo + baseline commit ${baseline.value.sha.slice(0, 8)} in ${opts.projectDir}`
        : `Created baseline commit ${baseline.value.sha.slice(0, 8)} (repo had no HEAD)`,
    });
  }

  // Probe the worker environment contract through the real agent path before
  // committing a 30-minute chunk to it. A broken seam (path anchoring, write
  // gate, bash cwd, report shape) halts here with the contract named instead
  // of surfacing as an unexplained chunk-1 flail.
  const preflight = await runPreflightProbe({
    projectDir: opts.projectDir,
    parentSessionId: opts.parentSessionId,
    parentOpId: opts.parentOpId,
    signal: opts.signal,
  });
  if (preflight.status === "fail") {
    return haltedResult(
      `preflight probe failed before chunk ${chunks[startIdx].number} — broken contract [${preflight.contract}]: ${preflight.detail}`,
      chunks[startIdx].number, outcomes, events,
    );
  }
  if (preflight.status === "pass") {
    emit({
      type: "preflight", chunkNumber: chunks[startIdx].number, totalChunks,
      message: preflight.warning
        ? `Preflight probe passed in ${Math.round(preflight.durationMs / 1000)}s (environment verified) — ${preflight.warning}`
        : `Preflight probe passed in ${Math.round(preflight.durationMs / 1000)}s — worker invocation, path anchoring, write gate, and bash cwd all verified.`,
    });
  }

  const endIdx = opts.maxChunks ? Math.min(startIdx + opts.maxChunks, totalChunks) : totalChunks;

  // Path selection (S3). maxConcurrentChunks defaults to 1 → the serial loop
  // below runs UNCHANGED (byte-identical to pre-S3 behaviour). Only >1 takes
  // the new parallel-worktree wave path, which never runs concurrent chunks in
  // opts.projectDir (each gets its own isolated worktree). The shared git
  // baseline + preflight probe above have already run for both paths.
  const maxConcurrentChunks = resolveMaxConcurrentChunks(opts.maxConcurrentChunks);
  const ran = maxConcurrentChunks > 1
    ? await runParallelWaves({
      opts,
      chunks: chunks.slice(startIdx, endIdx),
      totalChunks,
      maxConcurrentChunks,
      emit,
      events,
      outcomes,
    })
    : await runChunksInOrder({ opts, startIdx, endIdx, emit, events, outcomes });
  // Chunks the build lead split off this run are built next, serially (split-chunks.ts).
  const { result, plan } = endIdx === totalChunks
    ? await buildSplitOffs(opts, ran, (o, from) => runChunksInOrder({ opts: o, startIdx: from, endIdx: o.plan.chunks.length, emit, events, outcomes }))
    : { result: ran, plan: opts.plan };

  // A run that lands the plan's last chunk goes on to the finish gates; their
  // fix chunks are built here, serially, like any chunk of the plan.
  return runFinishGates({
    opts: { ...opts, plan }, result, emit, reachedPlanEnd: endIdx === totalChunks,
    buildFixes: (fixOpts) => runChunksInOrder({ opts: fixOpts, startIdx: 0, endIdx: fixOpts.plan.chunks.length, emit, events, outcomes }),
  });
}

/**
 * The chunk that closes a phase pauses at the phase's verification gate, and
 * the phase is scored there when the project carries a .lax-launch.json:
 * score >= 7 → proceed; below → one fix-worker, re-score, halt if still
 * below; no launch spec → the halt stands, for manual scoring.
 *
 * A phase with a chunk set aside or waiting cannot be scored yet: its closing
 * chunk lands like any accepted chunk and the phase owes its gate (`gateOwed`),
 * which the run that lands the phase's last chunk scores (phase-gate-pause.ts).
 */
async function scorePhaseIfPaused(a: {
  opts: LoopOptions; chunk: ParsedChunk; totalChunks: number; emit: EmitFn; ledger: SetAsideLedger; attempt: ChunkAttemptResult;
}): Promise<ChunkAttemptResult & { gateOwed?: boolean }> {
  const { opts, chunk, totalChunks, emit, attempt } = a;
  if (!isPhaseGatePause(attempt.finalOutcome)) return attempt;
  const notLanded = [...a.ledger.setAside, ...a.ledger.waiting].map((c) => c.chunk)
    .filter((n) => opts.plan.chunks.find((c) => c.number === n)?.phase === chunk.phase);
  if (notLanded.length > 0) {
    emit({
      type: "review-result", chunkNumber: chunk.number, totalChunks,
      message: `${chunk.phase}: not scored at its gate, since chunk(s) ${notLanded.join(", ")} of it did not land this run. Chunk ${chunk.number} lands unscored.`,
    });
    return { finalOutcome: attempt.finalOutcome, finalAction: "proceed", gateOwed: true };
  }
  const recovery = await attemptPhaseGateScoring(opts, chunk, emit, totalChunks);
  if (recovery.kind === "recovered") {
    emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `phase-gate auto-scoring passed — overriding halt to proceed` });
    return { finalOutcome: attempt.finalOutcome, finalAction: "proceed" };
  }
  if (recovery.kind === "unverified") {
    recordOwed(opts.projectDir, { check: `phase gate: ${chunk.phase}`, why: `${chunk.phase}'s scenarios were not judged at its gate: ${recovery.reason}` });
    emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `${chunk.phase}: phase gate unverified, continuing: ${recovery.reason}` });
    return { finalOutcome: attempt.finalOutcome, finalAction: "proceed" };
  }
  if (recovery.kind === "halt-with-context") {
    return { finalOutcome: { ...attempt.finalOutcome, reasoning: recovery.reason }, finalAction: attempt.finalAction };
  }
  return attempt;
}

/**
 * The serial path: build the chunks of the window one after another in the
 * project tree. A chunk that is still not green is set aside, as on the
 * parallel path: its work is moved out of the tree onto a branch
 * (tree-set-aside.ts), the chunks that depend on it wait, and the rest build
 * on. The run then ends halted, saying what landed and what did not.
 */
async function runChunksInOrder(run: {
  opts: LoopOptions;
  startIdx: number;
  endIdx: number;
  emit: EmitFn;
  events: LoopEvent[];
  outcomes: LoopResult["outcomes"];
}): Promise<LoopResult> {
  const { opts, startIdx, endIdx, emit, events, outcomes } = run;
  const chunks = opts.plan.chunks;
  const totalChunks = chunks.length;
  let chunksCommitted = 0;
  // Chunks an earlier run landed past one it set aside are not built again.
  const alreadyLanded = new Set(opts.landedChunks ?? []);
  const ledger = createSetAsideLedger();
  const landedThisRun: number[] = [];
  const endSetAside = (): LoopResult => endWithSetAside(ledger, landedThisRun, { chunksCommitted, totalChunks, emit, events, outcomes });
  // Phases an earlier run left owing their gate are scored here once their last chunk lands.
  const phasePauses = createPhasePauseTracker({
    projectDir: opts.projectDir, planChunks: chunks,
    landedBefore: [...chunks.slice(0, startIdx).map((c) => c.number), ...alreadyLanded],
  });
  const wallProbe = createWallProbe(opts);

  for (let i = startIdx; i < endIdx; i++) {
    if (opts.signal?.aborted) {
      return haltedResult("loop aborted by signal", chunks[i].number, outcomes, events);
    }

    const chunk = chunks[i];
    if (alreadyLanded.has(chunk.number)) continue;
    // A chunk that depends on one that did not land is not started.
    const [waiting] = holdBackWaiting(ledger, [chunk]).held;
    if (waiting) {
      emit({ type: "chunk-set-aside", chunkNumber: chunk.number, totalChunks, message: `Chunk ${chunk.number} not started: it depends on chunk ${waiting.on}, which did not land.` });
      opts.onChunkSettled?.(chunk.number);
      continue;
    }
    emit({ type: "chunk-start", chunkNumber: chunk.number, totalChunks, message: `Starting chunk ${chunk.number}/${totalChunks}: ${chunk.title} (${chunk.klass})` });

    const preSha = await safeGet(() => getHeadSha(opts.projectDir));
    if (!preSha.ok) {
      return haltedResult(`git rev-parse HEAD failed before chunk ${chunk.number}: ${preSha.error}`, chunk.number, outcomes, events);
    }

    // Build, review and judge the chunk; a push_back is fixed round by round
    // (handle-push-back.ts). A chunk an earlier run set aside starts from its
    // kept work and findings (carry-over.ts). Already-committed chunks'
    // distilled learnings go into its task so the worker inherits SPEC_GAPS /
    // NOTE context instead of rediscovering the project from zero.
    const carryOver = pickUpSetAsideWork({ projectDir: opts.projectDir, tree: opts.projectDir, chunk, totalChunks, emit });
    // Where the chunk has got to, for a pause or a restart to keep (orchestrator/run-control.ts).
    const inTree = (round: number, findings: string[]) => opts.onChunkInTree?.({ chunk: chunk.number, title: chunk.title, preSha: preSha.value, round, findings });
    inTree(carryOver?.round ?? 0, carryOver?.findings ?? []);
    const attempt = await buildChunkWithRetry({
      opts, chunk, totalChunks, emit, preSha: preSha.value, priorOutcomes: outcomes,
      ...(carryOver ? { carryOver } : {}), onRound: inTree,
    });
    const { finalOutcome, finalAction, gateOwed } = await scorePhaseIfPaused({ opts, chunk, totalChunks, emit, ledger, attempt });

    outcomes.push({ chunkNumber: chunk.number, outcome: finalOutcome, action: finalAction });
    if (stoppedMidChunk(finalAction, opts.signal)) return haltedResult("loop aborted by signal", chunk.number, outcomes, events);

    if (isSetAsideCase(finalAction, isPhaseGatePause(finalOutcome), opts.signal)
      && setChunkAsideInTree({ projectDir: opts.projectDir, chunk, totalChunks, preSha: preSha.value, outcome: finalOutcome, ledger, emit })) {
      opts.onChunkSettled?.(chunk.number);
      if (await stopForSetAside(ledger, { chunkNumber: chunk.number, totalChunks, lead: opts.buildLead, signal: opts.signal, emit })) return endSetAside();
      continue;
    }

    // Surface launch-readiness items regardless of action (they don't
    // halt by default — the launch-readiness gate halts only when items
    // are vague). When they're concrete, append them now.
    if (finalOutcome.report.launchReadiness) {
      emitLaunchReadiness(opts.projectDir, chunk, finalOutcome.report.launchReadiness);
      emit({
        type: "launch-readiness-emitted", chunkNumber: chunk.number, totalChunks,
        message: `Launch-readiness item recorded.`,
        data: { item: finalOutcome.report.launchReadiness.slice(0, 200) },
      });
    }

    const handled = await handleAction({
      chunk, totalChunks,
      projectDir: opts.projectDir,
      finalAction, finalOutcome,
      chunksCommitted, outcomes, events, emit,
    });
    if (handled.kind === "halt") return handled.result;
    chunksCommitted = handled.chunksCommitted;
    landedThisRun.push(chunk.number);
    recordLanded(opts.projectDir, chunk.number, finalOutcome.owed);
    // Its kept branches are merged now: the engine's own merged branches go (worktree-junctions.ts).
    pruneMergedAgentBranches(opts.projectDir);
    opts.onChunkSettled?.(chunk.number);
    phasePauses.landed(chunk, finalOutcome, !gateOwed);
    const phase = await phasePauses.scoreFinished({ opts, totalChunks, emit, events, outcomes }, chunksCommitted);
    if (phase.kind === "halt") return phase.result;
    const probe = await wallProbe.afterLanding({ opts, totalChunks, emit, events, outcomes }, chunk.number, chunksCommitted);
    if (probe.kind === "halt") return probe.result;
  }

  if (anythingSetAside(ledger)) return endSetAside();
  emit({ type: "complete", chunkNumber: chunks[endIdx - 1].number, totalChunks, message: `Loop complete: ${chunksCommitted} chunks committed.` });
  return {
    status: "complete",
    lastChunk: chunks[endIdx - 1].number,
    chunksCommitted,
    haltReason: "",
    outcomes,
    events,
  };
}
