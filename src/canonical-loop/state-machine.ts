/**
 * Canonical state machine (PRD §10).
 *
 * Sole writer of `op.canonical.state`. Validates transitions, syncs the
 * legacy `op.status` for callers using the existing public surface, persists
 * the op via writeOp, and emits the `state_changed` canonical event.
 *
 * Issue 03 exercises queued→running and running→{succeeded,failed}.
 * Subsequent issues activate paused / cancelling / cancelled / re-leasing.
 *
 * Hard rule: nothing outside canonical-loop calls transitionOp(). Adapters,
 * workers (other than via this module), and the public control API never
 * write `canonical.state` directly.
 */
import { emit, clearEmittedErrorsForOp } from "./event-emitter.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { clearMiddlewareStateForOp } from "./middlewares/state.js";
import { clearEvidenceHistory } from "./middlewares/evidence-history.js";
import { clearRenderVerifyStateForOp } from "./turn-loop/render-verify.js";
import { clearBuildVerifyStateForOp } from "./turn-loop/build-verify.js";
import { clearDesignVerifyStateForOp } from "./turn-loop/design-verify.js";
import { clearSpecProbeStateForOp } from "./turn-loop/spec-probes.js";
import { clearSpecAuditStateForOp } from "./turn-loop/spec-audit.js";
import { clearEarnedDoneStateForOp } from "./middlewares/open-steps.js";
import { clearOpLedger } from "./instruction-ledger/ledger.js";
import { getSessionForOp } from "../ops/session-bridge.js";
import { getHookEngine } from "../hooks/hook-engine.js";
import type { Op, OpStatus } from "../ops/types.js";
import type { CanonicalEvent, CanonicalState } from "./types.js";
import {
  unregisterAdapterForOp,
  unregisterToolDispatcherForOp,
  unregisterToolsForOp,
  unregisterOpBaselineTokens,
} from "./runtime.js";
import { clearSessionWorkRoot } from "../workspace/paths.js";
import {
  prepareCanonicalLearnedOutcome, commitCanonicalLearnedOutcome, recordCanonicalLearningOutcome,
} from "./learned-effectiveness.js";
import type { LearnedOutcome } from "../protocols/learned-effectiveness.js";
import { isLearningOutcomeEligible } from "./turn-loop/record-outcome.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.state-machine");

const TRANSITIONS: Record<CanonicalState, ReadonlySet<CanonicalState>> = {
  // queued → failed covers system-level fast-fail (no adapter configured for
  // the op's lane/provider). Per-turn errors still go via running → failed.
  // queued → cancelled covers pre-lease cancel (op cancelled before a worker
  // ever leases it).
  queued:     new Set<CanonicalState>(["running", "failed", "cancelled"]),
  running:    new Set<CanonicalState>(["paused", "cancelling", "succeeded", "failed", "queued"]),
  paused:     new Set<CanonicalState>(["queued"]),
  cancelling: new Set<CanonicalState>(["cancelled"]),
  cancelled:  new Set<CanonicalState>(),
  succeeded:  new Set<CanonicalState>(),
  failed:     new Set<CanonicalState>(),
};

const LEGACY_STATUS: Record<CanonicalState, OpStatus> = {
  queued: "pending",
  running: "running",
  paused: "paused",
  cancelling: "running",
  cancelled: "cancelled",
  succeeded: "completed",
  failed: "failed",
};

const TERMINAL: ReadonlySet<CanonicalState> = new Set(["succeeded", "failed", "cancelled"]);
let beforePersistHook: () => void = () => undefined;

/** Deterministic persistence-failure seam for cross-platform recovery tests. */
export function _setBeforePersistHookForTests(hook: () => void = () => undefined): void {
  beforePersistHook = hook;
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: CanonicalState | undefined, public readonly to: CanonicalState) {
    super(`illegal canonical state transition: ${from ?? "<unset>"} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export interface TransitionOptions {
  learnedOutcome?: LearnedOutcome;
  learningSessionId?: string;
}

/**
 * Transition `op` from its current canonical state to `to`.
 * Throws on illegal transitions. Mutates the op, persists it, emits the
 * `state_changed` event with body `{ from, to, reason }`.
 */
export function transitionOp(
  op: Op,
  to: CanonicalState,
  reason: string,
  opts: TransitionOptions = {},
): CanonicalEvent {
  const from = op.canonical?.state;
  if (from === undefined) throw new IllegalTransitionError(from, to);
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) throw new IllegalTransitionError(from, to);

  if (!op.canonical) op.canonical = {};
  op.canonical.state = to;
  op.status = LEGACY_STATUS[to];
  if (to === "running" && !op.startedAt) op.startedAt = new Date().toISOString();
  if (TERMINAL.has(to) && !op.completedAt) op.completedAt = new Date().toISOString();
  let learnedReceipt: ReturnType<typeof prepareCanonicalLearnedOutcome> = null;
  const learningSessionId = opts.learnedOutcome
    ? opts.learningSessionId ?? getSessionForOp(op.id) ?? ""
    : "";
  const learningEligible = opts.learnedOutcome
    ? isLearningOutcomeEligible(op, learningSessionId)
    : false;
  if (TERMINAL.has(to)) {
    // Only callers that explicitly classified the outcome may feed learning.
    // Generic terminal transitions and user cancellation carry no quality
    // signal and must not be guessed into clean/aborted evidence.
    if (opts.learnedOutcome && learningEligible) {
      try {
        learnedReceipt = prepareCanonicalLearnedOutcome(
          op,
          opts.learnedOutcome,
          learningSessionId,
        );
      } catch (error) {
        logger.warn(`[learned-effectiveness] prepare failed for ${op.id}: ${(error as Error).message}`);
      }
    }
    // Drop per-op middleware state + evidence history on terminal so the
    // canonical-loop registries don't grow unbounded across the process
    // lifetime. Safe to call repeatedly (no-op if state was never set for
    // this op).
    clearMiddlewareStateForOp(op.id);
    clearEvidenceHistory(op.id);
    clearEmittedErrorsForOp(op.id);
    clearRenderVerifyStateForOp(op.id);
    clearBuildVerifyStateForOp(op.id);
    clearDesignVerifyStateForOp(op.id);
    clearSpecProbeStateForOp(op.id);
    clearSpecAuditStateForOp(op.id);
    clearEarnedDoneStateForOp(op.id);
    clearOpLedger(op.id);
    unregisterAdapterForOp(op.id);
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
    unregisterOpBaselineTokens(op.id);
    clearSessionWorkRoot(op.id);
    // User-configured Stop hooks (~/.lax/hooks.json): the op reached a terminal
    // state — the LAX analog of "the agent finished". Fully detached: a Stop
    // hook observes (notify, log, kick a CI run), it can never block or delay
    // the transition. Fired before the state_changed emit below, so the
    // session binding is still readable here.
    getHookEngine().fireDetached({
      event: "Stop",
      opId: op.id,
      opStatus: to,
      sessionId: getSessionForOp(op.id),
    });
  }
  // Loop-side write — preserve control-API signal and lease columns from disk
  // so a concurrent control request or exact lease claim is not clobbered.
  beforePersistHook();
  persistOpKeepingSignals(op);

  if (learnedReceipt) {
    try { commitCanonicalLearnedOutcome(op, learnedReceipt); }
    catch (error) {
      logger.warn(`[learned-effectiveness] commit failed for ${op.id}: ${(error as Error).message}`);
    }
  }
  if (opts.learnedOutcome && learningEligible) {
    try {
      recordCanonicalLearningOutcome(
        op,
        opts.learnedOutcome,
        learningSessionId,
        learnedReceipt?.timestamp,
      );
    } catch (error) {
      logger.warn(`[cross-session-learning] outcome failed for ${op.id}: ${(error as Error).message}`);
    }
  }

  return emit(op.id, "state_changed", { from, to, reason });
}

export function isTerminalCanonicalState(s: CanonicalState): boolean {
  return TERMINAL.has(s);
}
