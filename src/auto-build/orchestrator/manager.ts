/**
 * Build orchestrator manager — runs the build loop as a background op
 * with full sidebar visibility and restart-resumability.
 *
 * Lifecycle:
 *   1. `startOrchestration` registers a new orchestrator run, kicks off
 *      the loop in the main process (NOT the worker pool — orchestrators
 *      run hours, workers are short-lived). Returns the opId immediately.
 *   2. The loop runs; on every chunk event we (a) persist state to disk
 *      so a restart can resume, and (b) broadcast a `bg_op_progress`
 *      event into the originating chat session for sidebar visibility.
 *   3. On halt or complete, a structured BuildRunSummary lands as a
 *      `bg_op_completed` event with `metadata.kind = "build-run-summary"`
 *      so the client renders the summary card instead of a text dump.
 *
 * Why a separate "manager" instead of folding into the worker pool: the
 * pool is designed for one-shot delegated work — submit a task, get a
 * result. An orchestrator runs for hours, supervises sub-processes, and
 * holds state across many gate decisions. Different shape, different
 * lifecycle. They share the same UI surface (bg_op_* events) but
 * different control plane.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { ParsedPlan } from "../plan-parser.js";
import { runBuildLoop, type LoopEvent, type LoopResult } from "../loop.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import type { ChunkJudge } from "../chunk-review/chunk-verdict.js";
import { buildSummaryMetadata, buildSummaryText, collectChangedFiles } from "./run-summary.js";
import { reportBuildToChat } from "./report-to-chat.js";
import { writeLeadLedger } from "./lead-ledger.js";
import * as state from "./state.js";
import { canHaveLead } from "../advisor/lead-chat.js";
import type { OrchestratorState } from "./state.js";
import * as registry from "./registry.js";
import { createLogger } from "../../logger.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { updateAppBuildWorkflow } from "../workflow-state.js";
import { OP_TYPE } from "../../ops/op-types.js";
import type { FinishProgress } from "../finish-gates/fix-chunk.js";
import { endStoppedRun, type BuildStop } from "./stopped-run.js";

const logger = createLogger("auto-build.orchestrator");

function syncWorkflowPhase(
  orch: Pick<ActiveOrchestration, "sessionId" | "projectDir" | "opId">,
  phase: "running" | "halted" | "complete",
): void {
  updateAppBuildWorkflow(orch.sessionId, {
    phase,
    projectDir: orch.projectDir,
    opId: orch.opId,
  });
}

/** In-memory registry of active orchestrations. Key = opId. */
const active = new Map<string, ActiveOrchestration>();

interface ActiveOrchestration {
  opId: string;
  sessionId: string;
  projectDir: string;
  startedAt: number;
  abortController: AbortController;
  /** Snapshot of latest state — written to disk on every event. */
  liveState: OrchestratorState;
  /** Logical completions already applied; guards duplicate landed events. */
  landedChunks: Set<number>;
  /** How many plan chunks come before the run's scope: they landed earlier. */
  scopeStartIdx: number;
  /** Ordered run scope; durable counts may advance only across its landed prefix. */
  scopeChunks: number[];
  /** The owner stopped it (run-control.ts): the loop's end is a pause or a cancel, not a halt. */
  stop?: BuildStop;
}

export interface StartOrchestrationOptions {
  sessionId: string;
  projectDir: string;
  planPath: string;
  plan: ParsedPlan;
  startingChunk: number;
  maxChunks?: number;
  /** Chunks in scope that an earlier run of this build landed: a resume
   *  passes them, so they are skipped and count as landed. A fresh start
   *  passes none. */
  landedChunks?: number[];
  judgmentHook?: JudgmentHook;
  chunkJudge?: ChunkJudge;
  /** Run the finish gates once the plan's last chunk lands (loop/types.ts). */
  finishGates?: boolean;
  subprocessTimeoutMs?: number;
  /** A paused build resumed keeps its id, so its card in the AGENTS panel goes on. */
  opId?: string;
  /** Where an earlier run of this build left its finish checks. */
  finishProgress?: FinishProgress;
}

export interface StartOrchestrationResult {
  opId: string;
  /** Synchronous initial event the tool result includes so the agent has something to surface. */
  initialMessage: string;
}

/**
 * Kick off a build orchestration. Returns immediately with the opId.
 * The loop runs in the background; the chat session receives
 * bg_op_progress and bg_op_completed events.
 */
export function startOrchestration(opts: StartOrchestrationOptions): StartOrchestrationResult {
  // Idempotency guard (AB-2): at most one live orchestration per project_dir.
  // Two loops on the same directory interleave chunk agents and clobber each
  // other's `.lax-build-run.json`. Callers that legitimately continue a run
  // (build_plan_resume, auto-resume) must let the prior loop reach a terminal
  // state first — the in-memory entry is deleted only when the loop ends.
  const existing = findActiveByProjectDir(opts.projectDir);
  if (existing) {
    throw new Error(
      `An orchestration is already running for ${opts.projectDir} (op ${existing.opId}). ` +
      `Abort it or wait for it to halt before starting another.`,
    );
  }

  const previousState = state.read(opts.projectDir);
  const opId = opts.opId ?? "op_" + randomBytes(8).toString("hex");
  const initialState = state.makeInitial({
    opId,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    planPath: opts.planPath,
    totalChunks: opts.plan.chunks.length,
    startingChunk: opts.startingChunk,
    maxChunks: opts.maxChunks,
    landedChunks: opts.landedChunks,
    finish: opts.finishProgress,
    planChunks: opts.plan.chunks.map((chunk) => chunk.number),
  });
  if (!state.write(initialState)) {
    throw new Error(
      `Build orchestration did not start: failed to persist ${state.ORCHESTRATOR_STATE_FILENAME}.`,
    );
  }

  // Add to the cross-restart registry so the boot scanner can auto-
  // resume if LAX dies mid-build.
  const registered = registry.register({
    projectDir: opts.projectDir,
    opId,
    sessionId: opts.sessionId,
    registeredAt: new Date().toISOString(),
  });
  if (!registered) {
    const restored = previousState
      ? state.write(previousState)
      : state.clear(opts.projectDir);
    if (!restored) state.clear(opts.projectDir);
    throw new Error(
      "Build orchestration did not start: failed to persist the active-orchestrator registry." +
      (restored ? "" : " The previous project state could not be restored."),
    );
  }

  const ac = new AbortController();
  const scopeStartIdx = opts.plan.chunks.findIndex(chunk => chunk.number === opts.startingChunk);
  const scopeChunks = state.runScopeOf(opts.plan.chunks.map((chunk) => chunk.number), opts.startingChunk, opts.maxChunks);
  const orch: ActiveOrchestration = {
    opId,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    startedAt: Date.now(),
    abortController: ac,
    liveState: initialState,
    landedChunks: new Set((opts.landedChunks ?? []).filter((n) => scopeChunks.includes(n))),
    scopeChunks,
    scopeStartIdx: Math.max(0, scopeStartIdx),
  };
  try {
    syncWorkflowPhase(orch, "running");
  } catch (error) {
    const unregistered = registry.unregister(opts.projectDir);
    const restored = previousState
      ? state.write(previousState)
      : state.clear(opts.projectDir);
    throw new Error(
      `Build orchestration did not start: failed to persist Product Build running state: ${(error as Error).message}` +
      (unregistered ? "" : " The active-orchestrator registry could not be rolled back.") +
      (restored ? "" : " The previous project state could not be restored."),
    );
  }

  active.set(opId, orch);

  broadcastToSession(opts.sessionId, {
    type: "bg_op_started",
    opId,
    // The project's name, not its path: the card read "Worker: Build orchestrator:
    // C:\Users\...\label-check-sol" (2026-11-25). workers-snapshot.ts names it the same way.
    task: `Build ${basename(opts.projectDir)} (chunks ${opts.startingChunk}-${opts.maxChunks ? opts.startingChunk + opts.maxChunks - 1 : opts.plan.chunks.length})`,
    provider: "build-orchestrator",
    // Mark this card as the SUPERVISOR / tree root — the agents panel keys a
    // distinct hub glyph (◈) + a persistent accent border off this opType so
    // the orchestrator never reads as just another worker card.
    opType: OP_TYPE.orchestrator,
  });

  // Run the loop async. Errors caught and emitted as halts; never throw
  // out of this function (it returned immediately).
  void runOrchestrationLoop(orch, opts);

  return {
    opId,
    initialMessage:
      `Build orchestrator started.\n` +
      `op_id: ${opId}\n` +
      `project_dir: ${opts.projectDir}\n` +
      `chunks: ${opts.startingChunk} → ${opts.maxChunks ? opts.startingChunk + opts.maxChunks - 1 : opts.plan.chunks.length} of ${opts.plan.chunks.length}\n` +
      `Live progress in the AGENTS sidebar. Do not poll for it (no sleep, no git log loops): end your turn now. ` +
      `When the build halts or finishes, this chat is woken with the result and can carry on from there; ` +
      `build_plan_status answers any time in between.`,
  };
}

async function runOrchestrationLoop(orch: ActiveOrchestration, opts: StartOrchestrationOptions): Promise<void> {
  try {
    const result: LoopResult = await runBuildLoop({
      projectDir: opts.projectDir,
      planPath: opts.planPath,
      plan: opts.plan,
      startingChunk: opts.startingChunk,
      maxChunks: opts.maxChunks,
      landedChunks: [...orch.landedChunks],
      signal: orch.abortController.signal,
      judgmentHook: opts.judgmentHook,
      chunkJudge: opts.chunkJudge,
      finishGates: opts.finishGates,
      // A build started from a chat is led by that chat (advisor/lead-chat.ts).
      ...(canHaveLead(opts.sessionId) ? { buildLead: { projectDir: opts.projectDir, originSessionId: opts.sessionId } } : {}),
      subprocessTimeoutMs: opts.subprocessTimeoutMs,
      parentSessionId: opts.sessionId,
      // The orchestrator card's id in the AGENTS panel IS orch.opId (it's the
      // bg_op_started.opId — see broadcastToSession above). Thread it down as
      // the chunk workers' spawn parent so their cards nest under this card.
      parentOpId: orch.opId,
      onEvent: (event) => onLoopEvent(orch, event),
      // Where the build is, kept for a pause or a restart to go on from (run-control.ts).
      ...(opts.finishProgress ? { finishProgress: opts.finishProgress } : {}),
      onChunkInTree: (inTreeChunk) => persist(orch, { ...orch.liveState, inTreeChunk }),
      onChunkSettled: (n) => persist(orch, state.settleChunk(orch.liveState, n)),
      onFinishProgress: (finish) => persist(orch, { ...orch.liveState, finish }),
    });

    if (orch.stop) endStoppedRun(orch, orch.stop);
    else await onLoopComplete(orch, result);
  } catch (e) {
    if (orch.stop) endStoppedRun(orch, orch.stop);
    else onLoopCrash(orch, e as Error);
  } finally {
    active.delete(orch.opId);
  }
}

function persist(orch: ActiveOrchestration, next: OrchestratorState): void {
  orch.liveState = next;
  state.write(next);
}

function onLoopEvent(orch: ActiveOrchestration, event: LoopEvent): void {
  // Update in-memory state + persist on chunk-state-changing events.
  if (event.type === "chunk-landed" && orch.scopeChunks.includes(event.chunkNumber)) orch.landedChunks.add(event.chunkNumber);
  const newState = state.applyLoopEvent(orch.liveState, event, orch.scopeChunks);
  orch.liveState = newState;
  state.write(newState);

  // Forward as bg_op_progress so the sidebar shows live status, and mirror
  // into the server log — a halted run's autopsy (which gate, what reasoning)
  // must survive the transient sidebar session.
  const line = `[${(event.elapsedMs / 1000).toFixed(1)}s] [chunk ${event.chunkNumber}/${event.totalChunks}] ${event.type}: ${event.message}`;
  logger.info(`[orchestrator] ${orch.opId} ${line}`);
  broadcastToSession(orch.sessionId, {
    type: "bg_op_progress",
    opId: orch.opId,
    line,
  });
}

async function onLoopComplete(orch: ActiveOrchestration, result: LoopResult): Promise<void> {
  const isHalted = result.status === "halted";
  if (isHalted) {
    orch.liveState = state.markHalted(orch.liveState, result.lastChunk, "loop-halt", result.haltReason);
  } else {
    orch.liveState = state.markComplete(orch.liveState);
  }
  state.write(orch.liveState);
  let workflowPersisted = true;
  try {
    syncWorkflowPhase(orch, isHalted ? "halted" : "complete");
  } catch (error) {
    workflowPersisted = false;
    logger.error(
      `[orchestrator] ${orch.opId} failed to persist workflow phase ${isHalted ? "halted" : "complete"}: ${(error as Error).message}`,
    );
  }

  // For clean completions, clear the state file so the next run starts
  // fresh. For halts, leave the file so resume works.
  if (!isHalted && workflowPersisted) {
    state.clear(orch.projectDir);
    registry.unregister(orch.projectDir);
  }
  // Halts stay in the registry so the user can find them via
  // build_plan_resume — registry.unregister fires only on terminal-clean.

  broadcastToSession(orch.sessionId, {
    type: "bg_op_completed",
    opId: orch.opId,
    status: isHalted ? "failed" : "completed",
    summary: buildSummaryText(orch.liveState, result),
    filesChanged: collectChangedFiles(result),
    metadata: buildSummaryMetadata(orch.liveState, result),
  });
  const ledgerWritten = await writeLeadLedger({
    projectDir: orch.projectDir, originSessionId: orch.sessionId, result, landed: [...orch.landedChunks], totalChunks: orch.liveState.totalChunks,
  });
  reportBuildToChat({
    sessionId: orch.sessionId, opId: orch.opId, projectDir: orch.projectDir, ledgerWritten,
    // Every chunk on the base branch: the ones before this run's scope and the
    // ones landed in it, in whatever order (a chunk set aside leaves a gap).
    chunksCommitted: orch.scopeStartIdx + orch.landedChunks.size, totalChunks: orch.liveState.totalChunks,
    ...(isHalted ? { halt: { chunk: orch.liveState.currentChunk, reason: orch.liveState.haltReason || result.haltReason } } : {}),
    filesChanged: collectChangedFiles(result),
    ...(result.openItems?.length ? { openItems: result.openItems } : {}),
  });

  logger.info(`[orchestrator] ${orch.opId} ${result.status}: chunks=${result.chunksCommitted}/${orch.liveState.totalChunks}`);
}

function onLoopCrash(orch: ActiveOrchestration, err: Error): void {
  orch.liveState = state.markHalted(orch.liveState, orch.liveState.currentChunk, "crash", err.message);
  state.write(orch.liveState);
  try {
    syncWorkflowPhase(orch, "halted");
  } catch (workflowError) {
    logger.error(
      `[orchestrator] ${orch.opId} failed to persist workflow phase halted: ${(workflowError as Error).message}`,
    );
  }
  broadcastToSession(orch.sessionId, {
    type: "bg_op_completed",
    opId: orch.opId,
    status: "failed",
    summary: `Build orchestrator crashed: ${err.message}\nState preserved at ${orch.projectDir}/${state.ORCHESTRATOR_STATE_FILENAME}. Run build_plan_resume to retry.`,
    filesChanged: [],
  });
  reportBuildToChat({
    sessionId: orch.sessionId, opId: orch.opId, projectDir: orch.projectDir,
    // Every chunk on the base branch: the ones before this run's scope and the
    // ones landed in it, in whatever order (a chunk set aside leaves a gap).
    chunksCommitted: orch.scopeStartIdx + orch.landedChunks.size, totalChunks: orch.liveState.totalChunks,
    halt: { chunk: orch.liveState.currentChunk, reason: `the build orchestrator crashed: ${err.message}` },
    filesChanged: [],
  });
  logger.error(`[orchestrator] ${orch.opId} crashed: ${err.message}`);
}

// ── Public introspection ─────────────────────────────────────────────────

export function getActive(opId: string): ActiveOrchestration | undefined {
  return active.get(opId);
}

function findActiveByProjectDir(projectDir: string): ActiveOrchestration | undefined {
  for (const o of active.values()) {
    if (o.projectDir === projectDir) return o;
  }
  return undefined;
}

/** True when an orchestration for this project is live in THIS process. */
export function isActiveForProject(projectDir: string): boolean {
  return findActiveByProjectDir(projectDir) !== undefined;
}

export function listActive(): Array<{ opId: string; projectDir: string; sessionId: string; startedAt: number }> {
  return Array.from(active.values()).map(o => ({
    opId: o.opId,
    projectDir: o.projectDir,
    sessionId: o.sessionId,
    startedAt: o.startedAt,
  }));
}

/** Stop a running build for the owner: a pause keeps it resumable, a cancel
 *  ends it (run-control.ts). False when no build with this id is running. */
export function stopRun(opId: string, stop: BuildStop): boolean {
  const o = active.get(opId);
  if (!o) return false;
  // A cancel overrides a pause still taking effect; a pause never downgrades a cancel.
  o.stop = stop === "cancelled" ? stop : o.stop ?? stop;
  o.abortController.abort();
  return true;
}
