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
 * primal_build_resume):
 *   - state.phase === "halted" — a real halt; user needs to read the
 *     reason and decide
 *   - state.phase === "complete" — nothing to do; remove from registry
 *   - state file missing / malformed — registry entry is stale; remove
 *   - project_dir no longer exists — same, remove
 *
 * Marks any unresumable entries as "abandoned" in the state file so the
 * user can see what happened.
 */

import { existsSync } from "node:fs";
import type { ParsedPlan } from "../plan-parser.js";
import { listAll, unregister } from "./registry.js";
import * as state from "./state.js";
import { startOrchestration } from "./manager.js";
import { parsePlanFile } from "../plan-parser.js";
import { defaultJudgmentHook } from "../chunk-review/judgment-hook.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { isFeatureEnabled } from "../tool.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("primal-auto-build.orchestrator.resume");

export interface ResumeReport {
  attempted: number;
  resumed: number;
  abandoned: number;
  cleared: number;
  details: Array<{ projectDir: string; outcome: "resumed" | "abandoned" | "cleared"; reason: string }>;
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
  const report: ResumeReport = { attempted: 0, resumed: 0, abandoned: 0, cleared: 0, details: [] };

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
    else if (outcome.outcome === "abandoned") report.abandoned++;
    else if (outcome.outcome === "cleared") report.cleared++;
  }

  if (report.attempted > 0) {
    logger.info(`[resume] scanned ${report.attempted} orchestrators: ${report.resumed} resumed, ${report.abandoned} abandoned, ${report.cleared} cleared`);
  }
  return report;
}

function tryResumeOne(projectDir: string, sessionId: string): { outcome: "resumed" | "abandoned" | "cleared"; reason: string } {
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

  if (s.phase === "halted") {
    // Don't auto-resume halts — user needs to see the reason. Leave the
    // state + registry in place so primal_build_resume can pick it up
    // when the user asks.
    return { outcome: "abandoned", reason: `halted before restart — reason: ${s.haltReason.slice(0, 100)}` };
  }

  // phase === "starting" or "running" — try to resume from resumeAtChunk
  const planPath = s.planPath;
  if (!existsSync(planPath)) {
    state.write(state.markAbandoned(s, "plan file missing after restart"));
    unregister(projectDir);
    return { outcome: "abandoned", reason: "plan file missing" };
  }

  let plan: ParsedPlan;
  try {
    plan = parsePlanFile(planPath);
  } catch (e) {
    state.write(state.markAbandoned(s, `plan parse failed after restart: ${(e as Error).message}`));
    unregister(projectDir);
    return { outcome: "abandoned", reason: `plan parse failed: ${(e as Error).message}` };
  }

  try {
    const kick = startOrchestration({
      sessionId,
      projectDir,
      planPath,
      plan,
      startingChunk: s.resumeAtChunk,
      maxChunks: s.maxChunks ?? undefined,
      judgmentHook: defaultJudgmentHook,
    });

    // Surface a notice in the originating chat session so the user
    // knows what happened.
    broadcastToSession(sessionId, {
      type: "bg_op_progress",
      opId: kick.opId,
      line: `[auto-resume] LAX restarted mid-build. Continuing from chunk ${s.resumeAtChunk}/${s.totalChunks}.`,
    });
    return { outcome: "resumed", reason: `restarted at chunk ${s.resumeAtChunk}` };
  } catch (e) {
    state.write(state.markAbandoned(s, `resume failed: ${(e as Error).message}`));
    unregister(projectDir);
    return { outcome: "abandoned", reason: `resume threw: ${(e as Error).message}` };
  }
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
