/**
 * The end of a build the owner stopped from its card (run-control.ts): a pause
 * or a cancel. Neither is a halt, and neither loses work: a chunk stopped
 * part-built in the project tree is moved onto its branch with the round it
 * was on (loop/tree-set-aside.ts parkInTreeChunk), and the state file keeps
 * where the build was, finish checks included. A paused build waits for
 * Resume, through a restart too (resume.ts); a cancelled one ends, and
 * build_plan_resume can still take it up from the same place.
 */
import * as state from "./state.js";
import type { OrchestratorState } from "./state.js";
import { parkInTreeChunk } from "../loop/tree-set-aside.js";
import { broadcastToSession } from "../../ops/session-bridge.js";
import { updateAppBuildWorkflow } from "../workflow-state.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("auto-build.orchestrator");

export type BuildStop = "paused" | "cancelled";

export interface StoppedRun {
  opId: string;
  sessionId: string;
  projectDir: string;
  liveState: OrchestratorState;
}

/** Move a part-built chunk's work out of the tree and off the state file.
 *  Returns the state without it, and a line saying what was kept. */
export function parkStoppedChunk(s: OrchestratorState): { state: OrchestratorState; kept: string } {
  if (!s.inTreeChunk) return { state: s, kept: "" };
  const kept = parkInTreeChunk(s.projectDir, s.inTreeChunk);
  const { inTreeChunk: _parked, ...rest } = s;
  return { state: rest, kept };
}

export function endStoppedRun(run: StoppedRun, stop: BuildStop): void {
  const { state: parked, kept } = parkStoppedChunk(run.liveState);
  const next = stop === "paused"
    ? state.markPaused(parked)
    : state.markHalted(parked, parked.currentChunk, "cancelled", `Cancelled by the owner.${kept ? ` ${kept}` : ""} build_plan_resume goes on from here.`);
  run.liveState = next;
  state.write(next);
  try {
    // The workflow bridge knows running, halted and complete: a stopped build is not running.
    updateAppBuildWorkflow(run.sessionId, { phase: "halted", projectDir: run.projectDir, opId: run.opId });
  } catch (e) {
    logger.error(`[orchestrator] ${run.opId} failed to persist workflow phase after ${stop}: ${(e as Error).message}`);
  }
  if (stop === "paused") {
    broadcastToSession(run.sessionId, {
      type: "bg_op_progress", opId: run.opId, status: "paused",
      line: `Paused by the owner.${kept ? ` ${kept}` : ""} Resume goes on from here.`,
    });
  } else {
    broadcastToSession(run.sessionId, {
      type: "bg_op_completed", opId: run.opId, status: "cancelled",
      summary: `Cancelled by the owner.${kept ? ` ${kept}` : ""}`, filesChanged: [],
    });
  }
  logger.info(`[orchestrator] ${run.opId} ${stop} by the owner at chunk ${next.currentChunk}${kept ? `: ${kept}` : ""}`);
}
