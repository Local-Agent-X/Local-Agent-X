/**
 * Checkpoint stop predicate — the ONE place that decides whether an op that
 * has just reached its iteration checkpoint should stop or keep going.
 *
 * Why this exists. `budget.maxIterations` used to mean two different things
 * depending on the lane: a hard wall for `interactive` and a mere cadence for
 * everything else. Neither was a real answer to "should this stop?". The wall
 * ended a chat at an arbitrary turn count that says nothing about whether the
 * work was finished or whether the op was stuck — a user who walked away came
 * back to an unfinished task with no explanation. The cadence gave unattended
 * lanes no brake at all.
 *
 * So maxIterations is now a CADENCE for every lane, and termination is decided
 * here by conditions that actually mean something:
 *
 *   (a) DRY CHECKPOINTS — two consecutive checkpoints that learned nothing.
 *       Evidence is loop-detection's `seenResultSigs` (already
 *       volatility-normalized by loop-progress.noveltySignature), the same
 *       definition budget-ladder uses for its rungs — extended to the
 *       checkpoint cadence, not forked. budget-ladder's own `dryRungs` counter
 *       is honored too, but it only covers the 25/50/75% rungs of ONE budget
 *       and resets itself when it fires, so it cannot be the whole signal for
 *       an unbounded cadence.
 *   (b) NUDGE CEILING — loop-detection has told the op it is looping more than
 *       NUDGE_CEILING times and it kept going. One more checkpoint of that is
 *       not going to help.
 *   (c) SPEND CEILING — real per-call API spend has reached the configured
 *       daily or session budget. Mirrors spend-cap-pack exactly, INCLUDING its
 *       oauth short-circuit: a flat-rate subscription's marginal cost for
 *       another turn is zero, so a USD ceiling must never stop that user.
 *
 * Cadence state lives in the per-op middleware registry (not a private Map) so
 * the existing op-terminal hook in event-emitter.ts clears it — no new leak.
 */
import { getMiddlewareState } from "./middlewares/state.js";
// NUDGE_CEILING is not re-exported by agent-guards/index.ts, so the whole
// loop-detection trio is imported from the defining module — one source, and
// the ceiling here can never drift from the one loop-detection enforces.
import { createLoopState, NUDGE_CEILING, type LoopState } from "../agent-guards/loop-detection.js";
import { getRuntimeConfig } from "../config.js";
import {
  getResolvedAuthSource,
  getSessionBillableCost,
  getTodayBillableCost,
} from "../cost-tracker.js";
import type { Op } from "../ops/types.js";

export type CheckpointStopReason = "dry-checkpoints" | "nudge-ceiling" | "spend-ceiling";

export interface CheckpointStopDecision {
  /** True when the op must terminate at this checkpoint. */
  stop: boolean;
  /** Machine-readable cause, null when continuing. */
  reason: CheckpointStopReason | null;
  /** One-line human explanation, null when continuing. */
  detail: string | null;
}

const CONTINUE: CheckpointStopDecision = { stop: false, reason: null, detail: null };

const LOOP_KEY = "loop-detection";
const LADDER_KEY = "budget-ladder";
const CADENCE_KEY = "checkpoint-cadence";

/** Consecutive no-new-evidence comparisons before stopping. Matches
 *  budget-ladder's own `dryRungs >= 2` threshold so "dry" means one thing. */
const DRY_LIMIT = 2;

/** budget-ladder's state, read-only here. Mirrors LadderState in
 *  middlewares/budget-ladder.ts — structural, so a shape change there is a
 *  type error here rather than a silent always-false read. */
interface LadderStateView {
  fired: Set<number>;
  lastEvidenceCount: number | null;
  dryRungs: number;
}

interface CadenceState {
  /** Distinct-result count at the previous checkpoint, null before the first. */
  lastEvidenceCount: number | null;
  /** Consecutive checkpoints that saw no new distinct results. */
  dryCheckpoints: number;
}

/**
 * Decide whether the op stops at this checkpoint.
 *
 * MUTATES the per-op cadence snapshot, so it must be called exactly once per
 * checkpoint — the worker's single `iteration_checkpoint` site is that caller.
 */
export function evaluateCheckpointStop(op: Op): CheckpointStopDecision {
  const loop = getMiddlewareState<LoopState>(op.id, LOOP_KEY, createLoopState);

  // (a) Dry checkpoints.
  const evidence = loop.seenResultSigs.size;
  const cadence = getMiddlewareState<CadenceState>(op.id, CADENCE_KEY, () => ({
    lastEvidenceCount: null,
    dryCheckpoints: 0,
  }));
  const dry = cadence.lastEvidenceCount !== null && evidence === cadence.lastEvidenceCount;
  cadence.dryCheckpoints = dry ? cadence.dryCheckpoints + 1 : 0;
  cadence.lastEvidenceCount = evidence;

  const ladder = getMiddlewareState<LadderStateView>(op.id, LADDER_KEY, () => ({
    fired: new Set<number>(),
    lastEvidenceCount: null,
    dryRungs: 0,
  }));

  if (cadence.dryCheckpoints >= DRY_LIMIT || ladder.dryRungs >= DRY_LIMIT) {
    return {
      stop: true,
      reason: "dry-checkpoints",
      detail: `two checkpoints in a row learned nothing new (${evidence} distinct results seen)`,
    };
  }

  // (b) Nudge ceiling. Same comparison loop-detection uses for its own abort.
  if (loop.nudgeCount > NUDGE_CEILING) {
    return {
      stop: true,
      reason: "nudge-ceiling",
      detail: `told it was looping ${loop.nudgeCount} times (ceiling ${NUDGE_CEILING}) and kept going`,
    };
  }

  // (c) Spend ceiling.
  return evaluateSpendCeiling(op);
}

function evaluateSpendCeiling(op: Op): CheckpointStopDecision {
  // Read live so a Settings change applies mid-op.
  const cfg = getRuntimeConfig();
  const dailyBudgetUsd = cfg.dailyBudgetUsd ?? 0;
  const sessionBudgetUsd = cfg.sessionBudgetUsd ?? 0;
  if (dailyBudgetUsd <= 0 && sessionBudgetUsd <= 0) return CONTINUE;

  // Flat-rate subscription (Claude CLI / SuperGrok / ChatGPT): the token×price
  // figure is a shadow estimate, not money, and another turn costs nothing at
  // the margin. A USD ceiling must never stop this user — the wall-clock
  // deadline and the dry/nudge conditions above still bound them. Same
  // short-circuit as tool-policy/packs/spend-cap-pack.ts.
  if (getResolvedAuthSource() === "oauth") return CONTINUE;

  if (dailyBudgetUsd > 0) {
    const spent = getTodayBillableCost().costUsd;
    if (spent >= dailyBudgetUsd) {
      return {
        stop: true,
        reason: "spend-ceiling",
        detail: `today's API spend ($${spent.toFixed(2)}) reached the configured daily budget ($${dailyBudgetUsd.toFixed(2)})`,
      };
    }
  }

  if (sessionBudgetUsd > 0 && op.sessionId) {
    const spent = getSessionBillableCost(op.sessionId).costUsd;
    if (spent >= sessionBudgetUsd) {
      return {
        stop: true,
        reason: "spend-ceiling",
        detail: `this session's API spend ($${spent.toFixed(2)}) reached the configured session budget ($${sessionBudgetUsd.toFixed(2)})`,
      };
    }
  }

  return CONTINUE;
}
