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
 *   (a) DRY CHECKPOINTS — two consecutive checkpoints that made no progress.
 *       Evidence is loop-detection's `progressTotal`, a MONOTONIC count fed by
 *       TWO sources: volatility-normalized distinct results (loop-progress.ts
 *       rememberNovelResult) and distinct mutation TARGETS (loop-detection
 *       noteToolResults). The second source exists because committing results
 *       are excluded from the novelty set on purpose — a write's "ok" text is
 *       not information — so an op that wrote a new file every turn had a
 *       counter that never moved and was stopped as "nothing new" with nine
 *       fresh files on disk. Rewriting one target with new bytes still counts
 *       as nothing: that IS the livelock shape. It is deliberately NOT
 *       `seenResultSigs.size` — that Set is a 256-entry FIFO whose size
 *       saturates, so a size comparison read every long, productive op as
 *       permanently dry past its 256th result and killed it mid-work while
 *       telling the user "nothing new turned up". budget-ladder's own
 *       `dryRungs` is not consulted either: it resets itself to 0 the moment it
 *       reaches 2, so a checkpoint could never observe it.
 *       KNOWN GAP: that FIFO also means a spin wider than 256 distinct results
 *       re-mints each result as novel after its eviction and never reads dry
 *       here. The cycle detector is the brake for it; the wall clock is
 *       NOT — worker.ts arms that timer for the interactive lane only,
 *       so a non-interactive op's maxWallTimeMs is stamped and never
 *       enforced. Open, and the reason a period-9 spin on a worker
 *       lane has no turn-based stop today.
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
import { getSessionBillableCost, getTodayBillableCost, isBillableSource } from "../cost-tracker.js";
import { readCanonicalEvents } from "./store.js";
import type { Op } from "../ops/types.js";
import type { CanonicalEvent } from "./types.js";

export type CheckpointStopReason = "dry-checkpoints" | "spend-ceiling";

// ── Reading a stop back ────────────────────────────────────────────────────
//
// The worker records a stop in exactly one place: its `iteration_checkpoint`
// event with `continuing: false` (worker.ts), emitted just before the op is
// ended `succeeded / iteration_checkpoint`. That event is the source of truth
// for "did this op finish, or did it stop mid-work?" — there is deliberately
// no second flag on the op row. Every surface that reports a terminal op goes
// through resolveTerminalOpStatus below, which reads it and renders `partial`
// with describeCheckpointStop:
//   - await-op.ts → OpResult (op_wait, op_status, op_submit, op_submit_batch)
//   - session-bridge-observer.ts → bg_op_completed / worker_done, the pending
//     notification the chat agent drains, the spoken line, the idle nudge
//   - broker-transport/phone-projection.ts → the durable `notification` item
//     a phone rebuilds from on every phone_projection_subscribe (it mapped
//     succeeded → "completed" with the worker's last text for a week too)
// Nothing enforces this list mechanically: a NEW terminal-reporting surface
// that maps `succeeded` straight to "completed" reintroduces the bug (the
// observer did exactly that for a week). Call the resolver; render the line.

export interface CheckpointStopFacts {
  /** Turns the op had completed when it stopped, when the event carried it. */
  completedTurns: number | null;
  reason: CheckpointStopReason | null;
  detail: string | null;
}

const STOP_REASONS: ReadonlySet<string> = new Set<CheckpointStopReason>(["dry-checkpoints", "spend-ceiling"]);

/** The stop recorded in an op's event log, or null when its latest checkpoint
 *  (if any) continued. A stop is always the LAST checkpoint the op reached. */
export function checkpointStopFromEvents(events: readonly CanonicalEvent[]): CheckpointStopFacts | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "iteration_checkpoint") continue;
    const b = event.body ?? {};
    if (b.continuing !== false) return null;
    const reason = typeof b.stopReason === "string" && STOP_REASONS.has(b.stopReason)
      ? (b.stopReason as CheckpointStopReason)
      : null;
    return {
      completedTurns: typeof b.completedTurns === "number" ? b.completedTurns : null,
      reason,
      detail: typeof b.stopDetail === "string" ? b.stopDetail : null,
    };
  }
  return null;
}

export function readCheckpointStop(opId: string): CheckpointStopFacts | null {
  return checkpointStopFromEvents(readCanonicalEvents(opId));
}

/**
 * The line a parent sees for a checkpoint-stopped child. Opens with the
 * literal PARTIAL marker so it cannot be mistaken for a finished result, then
 * says what to do: a `succeeded` op is terminal and cannot be resumed
 * (opResume is for `paused` only), so continuing means a follow-up op that
 * names the finished part. op_wait and op_status both show exactly this.
 */
export function describeCheckpointStop(opId: string, facts: CheckpointStopFacts): string {
  const turns = facts.completedTurns !== null ? ` after ${facts.completedTurns} turns` : "";
  const reason = `${facts.reason ?? "iteration-checkpoint"}${facts.detail ? `: ${facts.detail}` : ""}`;
  return `PARTIAL — child op ${opId} stopped at a checkpoint${turns} (reason: ${reason}); its work is saved but the task is NOT finished. To continue it, submit a follow-up op (op_submit_async) whose task states what this op already did (not_what_to_redo), or report the partial result to the user.`;
}

/** Terminal status every reporting surface renders for an op. `partial` is a
 *  `succeeded` op whose own checkpoint record says it stopped mid-work. */
export type TerminalOpStatus = "completed" | "partial" | "failed" | "cancelled";

export interface TerminalOpResolution {
  status: TerminalOpStatus;
  /** The stop record when status is `partial`, else null. */
  stop: CheckpointStopFacts | null;
  /** The PARTIAL line (describeCheckpointStop) when status is `partial`, else null. */
  partialSummary: string | null;
}

/**
 * The ONE mapping from an op's terminal state to the status a parent, card,
 * notification or phone shows. `state` is the canonical state (or the legacy
 * `completed` row status); anything that is not a known terminal state reads
 * as `failed`, never as a finished result.
 */
export function resolveTerminalOpStatus(opId: string, state: string): TerminalOpResolution {
  const stop = state === "succeeded" ? readCheckpointStop(opId) : null;
  if (stop) return { status: "partial", stop, partialSummary: describeCheckpointStop(opId, stop) };
  const status: TerminalOpStatus = state === "succeeded" || state === "completed"
    ? "completed"
    : state === "cancelled" ? "cancelled" : "failed";
  return { status, stop: null, partialSummary: null };
}

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
  /** progressTotal at the previous checkpoint, null before the first. */
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
  const evidence = loop.progressTotal;
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
      detail: `two checkpoints in a row learned nothing new (${evidence} distinct results or targets over the whole op)`,
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
  //
  // isBillableSource is the ONE authority on what counts as money. A hand-
  // rolled `=== "oauth"` here disagreed with it: a local-model (sentinel) op,
  // whose marginal cost is also zero, was stopped for API-key spend booked
  // earlier in the same session.
  if (!isBillableSource(op.contextPack?.routing?.authSource)) return CONTINUE;

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
