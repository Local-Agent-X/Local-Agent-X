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
import type { ParsedPlan } from "../plan-parser.js";
import { runBuildLoop, type LoopEvent, type LoopResult } from "../loop.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import * as state from "./state.js";
import type { OrchestratorState } from "./state.js";
import * as registry from "./registry.js";
import { createLogger } from "../../logger.js";
import { broadcastToSession } from "../../workers/session-bridge.js";

const logger = createLogger("primal-auto-build.orchestrator");

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
}

export interface StartOrchestrationOptions {
  sessionId: string;
  projectDir: string;
  planPath: string;
  plan: ParsedPlan;
  startingChunk: number;
  maxChunks?: number;
  judgmentHook?: JudgmentHook;
  subprocessTimeoutMs?: number;
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
  const opId = "op_" + randomBytes(8).toString("hex");
  const initialState = state.makeInitial({
    opId,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    planPath: opts.planPath,
    totalChunks: opts.plan.chunks.length,
    startingChunk: opts.startingChunk,
    maxChunks: opts.maxChunks,
  });
  state.write(initialState);

  const ac = new AbortController();
  const orch: ActiveOrchestration = {
    opId,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    startedAt: Date.now(),
    abortController: ac,
    liveState: initialState,
  };
  active.set(opId, orch);

  // Add to the cross-restart registry so the boot scanner can auto-
  // resume if LAX dies mid-build.
  registry.register({
    projectDir: opts.projectDir,
    opId,
    sessionId: opts.sessionId,
    registeredAt: new Date().toISOString(),
  });

  broadcastToSession(opts.sessionId, {
    type: "bg_op_started",
    opId,
    task: `Build orchestrator: ${opts.projectDir} (chunks ${opts.startingChunk}-${opts.maxChunks ? opts.startingChunk + opts.maxChunks - 1 : opts.plan.chunks.length})`,
    provider: "build-orchestrator",
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
      `Live progress in the AGENTS sidebar. The chat is free to use; a completion notice will arrive when the build halts or finishes.`,
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
      signal: orch.abortController.signal,
      judgmentHook: opts.judgmentHook,
      subprocessTimeoutMs: opts.subprocessTimeoutMs,
      onEvent: (event) => onLoopEvent(orch, event),
    });

    onLoopComplete(orch, result);
  } catch (e) {
    onLoopCrash(orch, e as Error);
  } finally {
    active.delete(orch.opId);
  }
}

function onLoopEvent(orch: ActiveOrchestration, event: LoopEvent): void {
  // Update in-memory state + persist on chunk-state-changing events.
  let newState = orch.liveState;
  if (event.type === "chunk-start") newState = state.markChunkStarted(newState, event.chunkNumber);
  else if (event.type === "commit") newState = state.markChunkCommitted(newState, event.chunkNumber);
  else if (event.type === "halt") newState = state.markHalted(newState, event.chunkNumber, "loop", event.message);
  orch.liveState = newState;
  state.write(newState);

  // Forward as bg_op_progress so the sidebar shows live status.
  const line = `[${(event.elapsedMs / 1000).toFixed(1)}s] [chunk ${event.chunkNumber}/${event.totalChunks}] ${event.type}: ${event.message}`;
  broadcastToSession(orch.sessionId, {
    type: "bg_op_progress",
    opId: orch.opId,
    line,
  });
}

function onLoopComplete(orch: ActiveOrchestration, result: LoopResult): void {
  const isHalted = result.status === "halted";
  if (isHalted) {
    orch.liveState = state.markHalted(orch.liveState, result.lastChunk, "loop-halt", result.haltReason);
  } else {
    orch.liveState = state.markComplete(orch.liveState);
  }
  state.write(orch.liveState);

  // For clean completions, clear the state file so the next run starts
  // fresh. For halts, leave the file so resume works.
  if (!isHalted) {
    state.clear(orch.projectDir);
    registry.unregister(orch.projectDir);
  }
  // Halts stay in the registry so the user can find them via
  // primal_build_resume — registry.unregister fires only on terminal-clean.

  broadcastToSession(orch.sessionId, {
    type: "bg_op_completed",
    opId: orch.opId,
    status: isHalted ? "failed" : "completed",
    summary: buildSummaryText(orch.liveState, result),
    filesChanged: collectChangedFiles(result),
    metadata: buildSummaryMetadata(orch.liveState, result),
  });

  logger.info(`[orchestrator] ${orch.opId} ${result.status}: chunks=${result.chunksCommitted}/${orch.liveState.totalChunks}`);
}

function onLoopCrash(orch: ActiveOrchestration, err: Error): void {
  orch.liveState = state.markHalted(orch.liveState, orch.liveState.currentChunk, "crash", err.message);
  state.write(orch.liveState);
  broadcastToSession(orch.sessionId, {
    type: "bg_op_completed",
    opId: orch.opId,
    status: "failed",
    summary: `Build orchestrator crashed: ${err.message}\nState preserved at ${orch.projectDir}/${state.ORCHESTRATOR_STATE_FILENAME}. Run primal_build_resume to retry.`,
    filesChanged: [],
  });
  logger.error(`[orchestrator] ${orch.opId} crashed: ${err.message}`);
}

function buildSummaryText(s: OrchestratorState, result: LoopResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${s.phase}`);
  lines.push(`Chunks: ${s.chunksCommitted}/${s.totalChunks} committed (last: chunk ${s.currentChunk})`);
  if (s.haltReason) lines.push(`Halt reason: ${s.haltReason}`);
  if (s.phase === "halted") {
    lines.push(`Resume with: primal_build_resume({project_dir: "${s.projectDir.replace(/\\/g, "/")}"})`);
  } else if (s.phase === "complete") {
    lines.push(`Build complete. Review LAUNCH_READINESS.md before deploying.`);
  }
  if (result.outcomes.length > 0) {
    lines.push(``);
    lines.push(`Per-chunk verdicts:`);
    for (const o of result.outcomes) {
      lines.push(`  chunk ${o.chunkNumber}: ${o.action}`);
    }
  }
  return lines.join("\n");
}

function buildSummaryMetadata(s: OrchestratorState, result: LoopResult): Record<string, unknown> {
  return {
    kind: "build-run-summary",
    project_dir: s.projectDir,
    project_name: s.projectDir.split(/[\\/]/).pop() || "project",
    phase: s.phase,
    chunks_committed: s.chunksCommitted,
    total_chunks: s.totalChunks,
    current_chunk: s.currentChunk,
    resume_at_chunk: s.resumeAtChunk,
    halt_gate: s.haltGate,
    halt_reason: s.haltReason,
    started_at: s.startedAt,
    updated_at: s.updatedAt,
    completed_at: s.completedAt,
    resumable: s.phase === "halted" || s.phase === "abandoned",
    per_chunk_verdicts: result.outcomes.map(o => ({ chunk: o.chunkNumber, action: o.action })),
  };
}

function collectChangedFiles(result: LoopResult): string[] {
  const set = new Set<string>();
  for (const o of result.outcomes) {
    for (const f of o.outcome.report.changed) set.add(f);
  }
  return Array.from(set);
}

// ── Public introspection ─────────────────────────────────────────────────

export function getActive(opId: string): ActiveOrchestration | undefined {
  return active.get(opId);
}

export function listActive(): Array<{ opId: string; projectDir: string; sessionId: string; startedAt: number }> {
  return Array.from(active.values()).map(o => ({
    opId: o.opId,
    projectDir: o.projectDir,
    sessionId: o.sessionId,
    startedAt: o.startedAt,
  }));
}

export function abort(opId: string): boolean {
  const o = active.get(opId);
  if (!o) return false;
  o.abortController.abort();
  return true;
}
