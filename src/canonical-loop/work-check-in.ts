/**
 * The work check-in — how a worker is found stuck without a clock.
 *
 * A spawned agent used to run under a wall clock (config.agentTimeoutMs, five
 * minutes), which ended agents that were working just as surely as agents
 * that were not: a feature-sized task was cut off mid-exploration with nothing
 * written. A timer is not a measure of progress. This is: every CHECK_IN_TURNS
 * turns, a worker with a work root has its tree fingerprinted — what git sees
 * as changed, with each changed file's size and mtime. A coding agent that is
 * getting somewhere changes bytes on disk; one that has read, planned, polled
 * and retried for STUCK_AFTER check-ins without changing a byte is stuck,
 * however novel its tool results look, and ends at a checkpoint as partial
 * with its committed turns intact.
 *
 * This closes the gap the clock was added for (worker-wall-clock.ts): a cycle
 * longer than the detector's window with one trivially novel result per lap
 * moved the loop's progress counter every time while touching nothing. The
 * dry-checkpoint rule (checkpoint-stop.ts) still catches the quieter shapes,
 * and the spend and token ceilings still bound cost; this bounds work that
 * produces no work.
 *
 * Only a worker with a work root is judged here — a read-only research op has
 * no tree to change — and only a git root can be fingerprinted cheaply; any
 * other root falls back to the dry-checkpoint rule.
 *
 * The loop spawns nothing (canonical-loop-11-boundary-audit), so the
 * fingerprint itself lives in agency/work-tree-fingerprint.ts and the server
 * registers it here at boot; until then every check-in reads "unknown".
 */
import { getMiddlewareState } from "./middlewares/state.js";
import { evaluateTokenCeiling, type CheckpointStopDecision } from "./checkpoint-stop.js";
import type { Op } from "../ops/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("canonical-loop.work-check-in");

/** Turns between check-ins. */
export const CHECK_IN_TURNS = 12;
/** Check-ins in a row with nothing changed on disk before the op is stuck:
 *  72 tool calls. Thinking is free — it happens inside a turn — so this
 *  bounds reading, polling and retrying, not deliberation; a complex task
 *  gets room to explore before its first write, and the stop is partial. */
export const STUCK_AFTER = 6;

const CHECK_IN_KEY = "work-check-in";

interface CheckInState {
  lastFingerprint: string | null;
  unchanged: number;
}

const CONTINUE: CheckpointStopDecision = { stop: false, reason: null, detail: null };

export type WorkTreeFingerprint = (root: string) => string | null;

let fingerprintTree: WorkTreeFingerprint | null = null;

/** Boot-time wiring: the function that fingerprints a work root. */
export function registerWorkTreeFingerprint(fn: WorkTreeFingerprint | null): void {
  fingerprintTree = fn;
}

/**
 * Called once per committed turn by the worker. Decides nothing except at a
 * check-in turn; there, a root whose fingerprint has not moved for
 * STUCK_AFTER check-ins in a row stops the op.
 */
export function evaluateWorkCheckIn(
  op: Op,
  completedTurns: number,
  fingerprint: WorkTreeFingerprint | null = fingerprintTree,
): CheckpointStopDecision {
  if (op.lane === "interactive") return CONTINUE;
  const root = op.contextPack?.routing?.workRoot;
  if (!root) return CONTINUE;
  if (completedTurns === 0 || completedTurns % CHECK_IN_TURNS !== 0) return CONTINUE;
  if (!fingerprint) return CONTINUE;
  const current = fingerprint(root);
  if (current === null) return CONTINUE;
  const state = getMiddlewareState<CheckInState>(op.id, CHECK_IN_KEY, () => ({ lastFingerprint: null, unchanged: 0 }));
  const unchanged = state.lastFingerprint !== null && current === state.lastFingerprint;
  state.unchanged = unchanged ? state.unchanged + 1 : 0;
  state.lastFingerprint = current;
  if (!unchanged) return CONTINUE;
  logger.info(`op=${op.id} check-in at turn ${completedTurns}: nothing changed on disk (${state.unchanged} in a row)`);
  if (state.unchanged < STUCK_AFTER) return CONTINUE;
  return {
    stop: true,
    reason: "no-change-on-disk",
    detail: `${STUCK_AFTER} check-ins in a row (${STUCK_AFTER * CHECK_IN_TURNS} turns) changed nothing under ${root}`,
  };
}

/** The worker's per-turn stops, in order: the op's token ceiling, then the
 *  check-in. One call so the worker's turn loop keeps one seam. */
export function evaluatePerTurnStop(op: Op, completedTurns: number): CheckpointStopDecision {
  const ceiling = evaluateTokenCeiling(op);
  return ceiling.stop ? ceiling : evaluateWorkCheckIn(op, completedTurns);
}
