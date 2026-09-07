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
 * So maxIterations is a CADENCE for every lane, and termination is decided
 * here by exactly two conditions that mean something:
 *
 *   (a) DRY CHECKPOINTS — two consecutive checkpoints that learned nothing.
 *       Evidence is loop-detection's `novelResultsTotal`: the MONOTONIC count
 *       of volatility-normalized distinct results (loop-progress.ts). It is
 *       deliberately NOT `seenResultSigs.size` — that Set is a 256-entry FIFO
 *       whose size saturates, so a size comparison read every long, productive
 *       op as permanently dry past its 256th result and killed it mid-work
 *       while telling the user "nothing new turned up". budget-ladder's own
 *       `dryRungs` is not consulted either: it resets itself to 0 the moment it
 *       reaches 2, so a checkpoint could never observe it.
 *   (b) SPEND CEILING — real per-call API spend has reached the configured
 *       daily or session budget (ON by default: $75 / $15, config-schema.ts).
 *       Judged on THIS op's credential source, never a process global: a
 *       flat-rate subscription's marginal cost for another turn is zero, so a
 *       USD ceiling must never stop that user — and with concurrent sessions
 *       the "last resolved" source belongs to whichever op resolved last, not
 *       to this one. The ledger itself already books oauth/local records as
 *       shadow cost (cost-tracker `isBillableSource`), so the short-circuit
 *       here is a second guard, not the only one.
 *
 * What is NOT here, and why: the loop-detection nudge ceiling. In the
 * interactive lane loop-detection hard-aborts the turn itself the moment
 * `nudgeCount > NUDGE_CEILING` (agent-guards/loop-detection.ts emitNudge),
 * and in every other lane the middleware passes deferWorkerPivot, which skips
 * every path that would call emitNudge (middlewares/loop-detection.ts) — so no
 * checkpoint can ever observe a count past the ceiling. A stop condition that
 * cannot fire is not shipped.
 *
 * Cadence state lives in the per-op middleware registry (not a private Map) so
 * the existing op-terminal hook in event-emitter.ts clears it — no new leak.
 */
import { getMiddlewareState } from "./middlewares/state.js";
import { createLoopState, type LoopState } from "../agent-guards/loop-detection.js";
import { getRuntimeConfig } from "../config.js";
import { getSessionBillableCost, getTodayBillableCost } from "../cost-tracker.js";
import type { Op } from "../ops/types.js";

export type CheckpointStopReason = "dry-checkpoints" | "spend-ceiling";

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
const CADENCE_KEY = "checkpoint-cadence";

/** Consecutive no-new-evidence comparisons before stopping. Matches
 *  budget-ladder's own `dryRungs >= 2` threshold so "dry" means one thing. */
const DRY_LIMIT = 2;

interface CadenceState {
  /** novelResultsTotal at the previous checkpoint, null before the first. */
  lastNovelTotal: number | null;
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
  const evidence = loop.novelResultsTotal;
  const cadence = getMiddlewareState<CadenceState>(op.id, CADENCE_KEY, () => ({
    lastNovelTotal: null,
    dryCheckpoints: 0,
  }));
  const dry = cadence.lastNovelTotal !== null && evidence === cadence.lastNovelTotal;
  cadence.dryCheckpoints = dry ? cadence.dryCheckpoints + 1 : 0;
  cadence.lastNovelTotal = evidence;

  if (cadence.dryCheckpoints >= DRY_LIMIT) {
    return {
      stop: true,
      reason: "dry-checkpoints",
      detail: `two checkpoints in a row learned nothing new (${evidence} distinct results over the whole op)`,
    };
  }

  // (b) Spend ceiling.
  return evaluateSpendCeiling(op);
}

function evaluateSpendCeiling(op: Op): CheckpointStopDecision {
  // Read live so a Settings change applies mid-op.
  const cfg = getRuntimeConfig();
  const dailyBudgetUsd = cfg.dailyBudgetUsd ?? 0;
  const sessionBudgetUsd = cfg.sessionBudgetUsd ?? 0;
  if (dailyBudgetUsd <= 0 && sessionBudgetUsd <= 0) return CONTINUE;

  // Per-op, not process-global. `routing.authSource` is stamped at op creation
  // from the credential this op actually runs on (chat-runner/create-op.ts,
  // agent-runner/register-adapter.ts) and is the same field cost-recording.ts
  // books the op's ledger row under. cost-tracker's getResolvedAuthSource() is
  // one value for the whole process — with two sessions in flight it would
  // exempt an API-key op because a subscription op resolved last, or stop a
  // subscription op for spend it never incurred.
  if (op.contextPack?.routing?.authSource === "oauth") return CONTINUE;

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
