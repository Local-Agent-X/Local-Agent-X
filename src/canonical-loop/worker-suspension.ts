/**
 * What a middleware's `suspend` directive does to an op.
 *
 * A worker op that stops making progress (repeat-failure, a model that went silent)
 * is paused, not failed: the user can fix the cause and Resume it. An op nobody ever
 * resumes is ended instead, because left paused it stays a live worker forever. Dream
 * runs (memory_consolidation) are scheduled maintenance whose next cycle redoes the
 * work: seven that suspended between July and September were still listed as running
 * workers on 2026-10-22, never resumed. The owner's call that day: end them.
 */
import { OP_TYPE } from "../ops/op-types.js";
import type { Op } from "../ops/types.js";
import { transitionOp } from "./state-machine.js";
import { recordTerminalOutcome } from "./turn-loop/record-outcome.js";
import { REPEAT_FAILURE_REASON } from "./middlewares/repeat-failure.js";

/** Op types nobody resumes: a suspension ends them. */
const ENDED_ON_SUSPEND: ReadonlySet<string> = new Set([OP_TYPE.memoryConsolidation]);

/** Record why `op` stopped, then pause it, or end it when it is never resumed. Either
 *  way the suspension (reason, detail, time) stays on the op as the account of why. */
export function applySuspension(op: Op, reason: string, message: string | undefined): "paused" | "ended" {
  if (!op.canonical) op.canonical = {};
  op.canonical.suspension = {
    reason: reason === REPEAT_FAILURE_REASON ? "blocked" : "stalled",
    detail: message ?? reason,
    suspendedAt: new Date().toISOString(),
  };
  if (op.type && ENDED_ON_SUSPEND.has(op.type)) {
    op.lastFailureReason = `suspended:${reason}`;
    recordTerminalOutcome(op, "aborted");
    transitionOp(op, "failed", `suspended:${reason}`, { learnedOutcome: "aborted" });
    return "ended";
  }
  transitionOp(op, "paused", `suspended:${reason}`);
  return "paused";
}
