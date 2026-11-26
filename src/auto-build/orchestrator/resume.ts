/**
 * Boot-time auto-resume for orchestrator runs that were in flight when
 * the LAX server last died.
 *
 * Called once during server bootstrap. Scans the active-orchestrators
 * registry (~/.lax/active-orchestrators.json), and for each entry whose
 * state file says `phase === "running"`, automatically restarts the
 * orchestrator at `resumeAtChunk` (i.e. the chunk after the last
 * successful commit).
 *
 * Failure modes that DON'T auto-resume (left for the user to handle via
 * build_plan_resume):
 *   - state.phase === "paused" — the owner paused it; it waits for Resume
 *   - state.phase === "halted" — a real halt; user needs to read the
 *     reason and decide
 *   - state.phase === "complete" — nothing to do; remove from registry
 *   - state file missing / malformed — registry entry is stale; remove
 *   - project_dir no longer exists — same, remove
 *
 * Marks genuinely unresumable entries as "abandoned" in the state file.
 * Deliberately halted entries remain waiting for explicit user action.
 */

import { existsSync } from "node:fs";
import type { ParsedPlan } from "../plan-parser.js";
import { listAll, unregister } from "./registry.js";
import * as state from "./state.js";
import { startOrchestration, isActiveForProject } from "./manager.js";
import { parsePlanFile } from "../plan-parser.js";
import { DEFAULT_CHUNK_REVIEW } from "../chunk-review/default-review.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { isFeatureEnabled } from "../tool.js";
import { sweepOrphanWorktreeJunctions } from "../../agency/worktree-recovery.js";
import { createLogger } from "../../logger.js";
import { parkStoppedChunk } from "./stopped-run.js";

const logger = createLogger("auto-build.orchestrator.resume");

type ResumeOutcome = "resumed" | "waiting" | "abandoned" | "cleared" | "skipped";

export interface ResumeReport {
  attempted: number;
  resumed: number;
  /** Deliberately halted and left resumable for explicit user action. */
  waiting: number;
  abandoned: number;
  cleared: number;
  /** Already live in this process — a duplicate resume was correctly skipped. */
  skipped: number;
  details: Array<{ projectDir: string; outcome: ResumeOutcome; reason: string }>;
}

/**
 * The boot resume. The worktree sweep runs first when there is a build to
 * resume: it keeps a crashed chunk's worktree, with the work its worker had
 * written, for the resumed build to claim (claimRecoveredWorktree, the chunk's
 * runId in parallel-waves.ts). Started on its own 5 s after boot, it ran after
 * the resume had already cut that chunk a fresh worktree, and the work sat
 * unclaimed. Never in a self_edit bind probe, which boots from inside the
 * worktree folder the sweep walks (index.ts).
 */
export async function resumeOrchestrationsAtBoot(): Promise<ResumeReport> {
  if (listAll().length > 0 && process.env.LAX_SELF_EDIT_PROBE !== "1") {
    try {
      await sweepOrphanWorktreeJunctions();
    } catch (e) {
      logger.warn(`[resume] worktree sweep before resume failed: ${(e as Error).message}`);
    }
  }
  return autoResumeOrchestrations();
}

/**
 * Scan registry + auto-resume eligible orchestrators. Idempotent — safe
 * to call multiple times (running orchestrations are registered in-memory
 * so a duplicate resume is detected and skipped).
 *
 * No-op when the feature flag is disabled (don't auto-restart builds the
 * operator has explicitly turned off).
 */
export function autoResumeOrchestrations(): ResumeReport {
  const report: ResumeReport = { attempted: 0, resumed: 0, waiting: 0, abandoned: 0, cleared: 0, skipped: 0, details: [] };

  if (!isFeatureEnabled()) {
    logger.info("[resume] feature flag disabled — skipping auto-resume scan");
    return report;
  }

  const entries = listAll();
  for (const entry of entries) {
    report.attempted++;
    const outcome = tryResumeOne(entry.projectDir, entry.sessionId);
    report.details.push({ projectDir: entry.projectDir, outcome: outcome.outcome, reason: outcome.reason });
    if (outcome.outcome === "resumed") report.resumed++;
    else if (outcome.outcome === "waiting") report.waiting++;
    else if (outcome.outcome === "abandoned") report.abandoned++;
    else if (outcome.outcome === "cleared") report.cleared++;
    else if (outcome.outcome === "skipped") report.skipped++;
  }

  if (report.attempted > 0) {
    logger.info(`[resume] scanned ${report.attempted} orchestrators: ${report.resumed} resumed, ${report.waiting} waiting, ${report.abandoned} abandoned, ${report.cleared} cleared, ${report.skipped} skipped`);
  }
  return report;
}

function tryResumeOne(projectDir: string, sessionId: string): { outcome: ResumeOutcome; reason: string } {
  // Idempotency guard (AB-2): if an orchestration for this project is already
  // live in-process, a second boot-scan (or double invocation) must NOT start
  // a duplicate loop — two loops interleave chunk agents and clobber state.
  // This is the "running orchestrations are detected and skipped" the module
  // docstring promises.
  if (isActiveForProject(projectDir)) {
    return { outcome: "skipped", reason: "orchestration already active in this process" };
  }

  // Project no longer exists → registry is stale.
  if (!existsSync(projectDir)) {
    unregister(projectDir);
    return { outcome: "cleared", reason: "project_dir no longer exists" };
  }

  const s = state.read(projectDir);
  if (!s) {
    unregister(projectDir);
    return { outcome: "cleared", reason: "state file missing or malformed" };
  }

  if (s.phase === "complete") {
    unregister(projectDir);
    state.clear(projectDir);
    return { outcome: "cleared", reason: "build was already complete" };
  }

  if (s.phase === "paused") {
    return { outcome: "waiting", reason: "paused by the owner — goes on when they press Resume" };
  }

  if (s.phase === "halted") {
    // Don't auto-resume halts — user needs to see the reason. Leave the
    // state + registry in place so build_plan_resume can pick it up
    // when the user asks.
    return { outcome: "waiting", reason: `halted before restart — resumable after explicit user action; reason: ${s.haltReason.slice(0, 100)}` };
  }

  // phase === "starting" or "running" — try to resume from resumeAtChunk
  let started: SavedStart;
  try {
    started = startFromSavedState(s, sessionId);
  } catch (e) {
    state.write(state.markAbandoned(s, `resume failed: ${(e as Error).message}`));
    unregister(projectDir);
    return { outcome: "abandoned", reason: `resume threw: ${(e as Error).message}` };
  }
  if (started.kind === "invalid") {
    state.write(state.markAbandoned(s, started.reason));
    unregister(projectDir);
    return { outcome: "abandoned", reason: started.reason };
  }
  const runEnd = started.window.kind === "complete";
  // Surface a notice in the originating chat session so the user knows what happened.
  broadcastToSession(sessionId, {
    type: "bg_op_progress",
    opId: started.opId,
    line: (runEnd
      ? `[auto-resume] LAX restarted after every chunk landed. Running the build's finish checks and its report.`
      : `[auto-resume] LAX restarted mid-build. Continuing from chunk ${started.window.startingChunk}/${s.totalChunks}.`) + (started.kept ? ` ${started.kept}` : ""),
  });
  return { outcome: "resumed", reason: runEnd ? "every chunk landed; running the build's end" : `restarted at chunk ${started.window.startingChunk}` };
}

export type SavedStart =
  | { kind: "started"; opId: string; initialMessage: string; window: Exclude<ResumeWindow, { kind: "invalid" }>; kept: string }
  | { kind: "invalid"; reason: string };

/**
 * Start a build again from its saved state: the chunk it was on, a part-built
 * chunk's kept work and round (moved onto its branch first when a quit or a
 * crash left it in the tree), and its finish checks' place. The one start for
 * the boot resume, build_plan_resume and the card's Resume (run-control.ts).
 * A paused build keeps its id, so its card goes on.
 */
export function startFromSavedState(s: state.OrchestratorState, sessionId: string, requestedStartingChunk?: number): SavedStart {
  if (!existsSync(s.planPath)) return { kind: "invalid", reason: "plan file missing" };
  let plan: ParsedPlan;
  try {
    plan = parsePlanFile(s.planPath);
  } catch (e) {
    return { kind: "invalid", reason: `plan parse failed: ${(e as Error).message}` };
  }
  // AB-8: resume must stay inside the user's original chunk window (computeResumeWindow).
  const window = computeResumeWindow(s, plan.chunks, requestedStartingChunk);
  if (window.kind === "invalid") return window;
  const { state: parked, kept } = parkStoppedChunk(s);
  if (kept) {
    state.write(parked);
    logger.info(`[resume] ${s.projectDir}: ${kept}`);
  }
  const runEnd = window.kind === "complete";
  const kick = startOrchestration({
    sessionId,
    projectDir: s.projectDir,
    planPath: s.planPath,
    plan,
    startingChunk: window.startingChunk,
    maxChunks: window.maxChunks,
    landedChunks: runEnd ? window.landedChunks : s.landedChunks,
    ...(runEnd && s.finish ? { finishProgress: s.finish } : {}),
    ...(s.phase === "paused" ? { opId: s.opId } : {}),
    ...DEFAULT_CHUNK_REVIEW,
  });
  return { kind: "started", opId: kick.opId, initialMessage: kick.initialMessage, window, kept };
}

export type ResumeWindow =
  | { kind: "resume"; startingChunk: number; maxChunks: number | undefined }
  /** Every chunk in the window landed, and the run had not ended: started over
   *  its window with every chunk landed, the loop builds none and runs the end
   *  (split-off chunks, the finish checks, the lead's ledger, the report to the
   *  chat). label-check-sol's server died in its finish checks and the restart
   *  marked the build complete, with no report to its chat (2026-11-25). */
  | { kind: "complete"; startingChunk: number; maxChunks: number | undefined; landedChunks: number[] }
  | { kind: "invalid"; reason: string };

/**
 * Compute the correct resume window from persisted state + the plan's chunks.
 *
 * The loop windows by INDEX (startIdx + maxChunks), so we clamp in index-space
 * against the user's ORIGINAL scope — [startingChunkOverride, +maxChunks) — not
 * the raw maxChunks (which would slide the window forward on every resume).
 *
 * Progress is derived from the number of committed chunks inside that index
 * window. This survives sparse plan numbering: committing chunk 1 in [1,3,5]
 * persists resumeAtChunk=2, but the next plan-index is correctly chunk 3.
 * Completion requires the committed count to prove progress past the scope end.
 */
export function computeResumeWindow(
  s: state.OrchestratorState,
  chunks: Array<{ number: number }>,
  requestedStartingChunk?: number,
): ResumeWindow {
  if (chunks.length === 0) return { kind: "invalid", reason: "build plan has no chunks" };

  const originalStart = s.startingChunkOverride ?? chunks[0].number;
  const origStartIdx = chunks.findIndex(c => c.number === originalStart);
  if (origStartIdx < 0) {
    return { kind: "invalid", reason: `original starting chunk ${originalStart} is not in the plan` };
  }
  if (s.maxChunks != null && (!Number.isInteger(s.maxChunks) || s.maxChunks <= 0)) {
    return { kind: "invalid", reason: "persisted max_chunks is invalid" };
  }
  if (!Number.isInteger(s.chunksCommitted) || s.chunksCommitted < 0) {
    return { kind: "invalid", reason: "persisted committed chunk count is invalid" };
  }
  const windowEndIdx = s.maxChunks != null
    ? Math.min(origStartIdx + s.maxChunks - 1, chunks.length - 1)
    : chunks.length - 1;
  const committedNextIdx = origStartIdx + s.chunksCommitted;
  // Once every chunk landed, build_plan_status reports resume-at one past the
  // last chunk; passed back, it names the build's end, not a chunk. Refusing it
  // left a lead with no starting_chunk that resumed (label-check-sol, 2026-11-25).
  const endRequested = committedNextIdx > windowEndIdx && requestedStartingChunk === s.resumeAtChunk;

  if (requestedStartingChunk != null && !endRequested) {
    const requestedIdx = chunks.findIndex(c => c.number === requestedStartingChunk);
    if (requestedIdx < 0) {
      return { kind: "invalid", reason: `starting_chunk ${requestedStartingChunk} is not in the plan` };
    }
    if (requestedIdx < origStartIdx || requestedIdx > windowEndIdx) {
      return { kind: "invalid", reason: `starting_chunk ${requestedStartingChunk} is outside the original build scope` };
    }
    if (requestedIdx < committedNextIdx) {
      return { kind: "invalid", reason: `starting_chunk ${requestedStartingChunk} is behind already committed progress` };
    }
    return {
      kind: "resume",
      startingChunk: requestedStartingChunk,
      maxChunks: s.maxChunks != null ? windowEndIdx - requestedIdx + 1 : undefined,
    };
  }

  if (committedNextIdx > windowEndIdx) {
    return {
      kind: "complete", startingChunk: originalStart, maxChunks: s.maxChunks ?? undefined,
      landedChunks: [...new Set([...chunks.slice(origStartIdx, windowEndIdx + 1).map((c) => c.number), ...(s.landedChunks ?? [])])],
    };
  }

  const currentIdx = chunks.findIndex(c => c.number === s.currentChunk);
  const resumeIdx = chunks.findIndex(c => c.number === s.resumeAtChunk);
  let nextWorkIdx = committedNextIdx;
  if (resumeIdx >= 0 && resumeIdx !== committedNextIdx) {
    return { kind: "invalid", reason: "persisted resume chunk disagrees with committed progress" };
  }
  if (resumeIdx < 0) {
    if (currentIdx === committedNextIdx) nextWorkIdx = currentIdx;
    else if (currentIdx === committedNextIdx - 1) nextWorkIdx = currentIdx + 1;
    else return { kind: "invalid", reason: "persisted sparse-plan progress is inconsistent" };
  }
  if (nextWorkIdx < origStartIdx || nextWorkIdx > windowEndIdx) {
    return { kind: "invalid", reason: "persisted chunk progress is inconsistent with the original build scope" };
  }

  return {
    kind: "resume",
    startingChunk: chunks[nextWorkIdx].number,
    maxChunks: s.maxChunks != null ? windowEndIdx - nextWorkIdx + 1 : undefined,
  };
}

/**
 * Read a project's orchestrator state without resuming. Used by status +
 * resume tools.
 */
export function readProjectState(projectDir: string): { state: state.OrchestratorState; planExists: boolean } | null {
  const s = state.read(projectDir);
  if (!s) return null;
  return {
    state: s,
    planExists: existsSync(s.planPath),
  };
}

// Re-export read helpers so tools can import from one place.
export { read as readState, clear as clearState } from "./state.js";
