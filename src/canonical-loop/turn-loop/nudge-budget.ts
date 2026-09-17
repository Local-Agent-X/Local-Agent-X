/**
 * The shared nudge budget — one cap per op across EVERY guard.
 *
 * Each guard used to carry its own private counter, so nothing bounded what
 * they cost together: a chat op could pay for a dozen extra model calls and
 * nobody saw a total (op-outcomes 2026-09-15: grok-4.6 took 48 nudges and 5.3M
 * tokens on one message; a cleanup guard misread a pasted conversation and
 * spent three more turns arguing with the model about a removal that never
 * happened).
 *
 * A nudge is the harness spending a model call to steer. Past a handful, the
 * steering is not working and the turn should end and say so — so the budget
 * is deliberately small and lane-shaped, not per-guard.
 *
 * Recovery re-drives are NOT steering: a transient provider error tells the
 * model nothing about its own work, and dropping the resume message would
 * strand the op mid-task. They are exempt, and only they.
 */
import { readOp } from "../../ops/op-store.js";
import { getMiddlewareState } from "../middlewares/state.js";
import { createLogger } from "../../logger.js";
import type { GuardFire } from "./guard-fire.js";

const logger = createLogger("canonical-loop.nudge-budget");

/** Someone is watching a chat turn and can redirect it themselves; an
 *  unattended lane has only the harness. app_build spends its budget on the
 *  verify gates (render/build/spec/design each retry their own check). */
const BUDGET_BY_OP_TYPE: Record<string, number> = {
  chat_turn: 4,
  app_build: 16,
};
const DEFAULT_BUDGET = 8;

const EXEMPT_REASONS = new Set(["adapter-retry", "reported-adapter-retry"]);

/**
 * Guards whose firing is bounded BY CONSTRUCTION, so they do not draw on the
 * shared pool. The budget exists to cap guards that could fire without limit;
 * these two cannot, and they are the ones that END a stuck op:
 *   budget-ladder   three rungs (25/50/75%) plus one dry-stop, ever;
 *   loop-detection  NUDGE_CEILING warnings, then it aborts the turn.
 *
 * In a flat first-come pool they lost to cheaper voices. muse's grade-school
 * op (2026-09-17) spent its 4 on two "a tool call failed" notices the model had
 * already acted on, the 25% rung, and one more failure notice — so the 50%
 * rung was refused and the op wandered on, unsteered, for 60+ turns without
 * writing a line. The pool's own contract is that steering stops when it isn't
 * working; the guards that decide it isn't working must be able to say so.
 */
const SELF_BOUNDED_GUARDS = new Set(["budget-ladder", "loop-detection"]);

export function nudgeBudgetFor(opType: string | undefined): number {
  return BUDGET_BY_OP_TYPE[opType ?? ""] ?? DEFAULT_BUDGET;
}

interface BudgetState { spent: number }

/** Charge one nudge against the op's budget. False → the caller must NOT
 *  append: the budget is gone and the turn has to end on what it has. */
export function consumeNudgeBudget(opId: string, source: GuardFire): boolean {
  if (EXEMPT_REASONS.has(source.reason) || SELF_BOUNDED_GUARDS.has(source.name)) return true;
  const state = getMiddlewareState<BudgetState>(opId, "nudge-budget", () => ({ spent: 0 }));
  const budget = nudgeBudgetFor(readOp(opId)?.type);
  if (state.spent >= budget) {
    logger.info(`op=${opId} nudge budget spent (${budget}) — "${source.name}" refused`);
    return false;
  }
  state.spent++;
  return true;
}

/** Nudges charged to this op so far. */
export function nudgesSpent(opId: string): number {
  return getMiddlewareState<BudgetState>(opId, "nudge-budget", () => ({ spent: 0 })).spent;
}
