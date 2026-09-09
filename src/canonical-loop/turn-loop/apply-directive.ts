/**
 * The turn's sticky middleware directive, applied AFTER commitTurn.
 *
 * Lifted out of turn-loop.ts as one unit because all three effects share the
 * same ordering contract: they must run once the turn row is durable. A nudge
 * materialized before commit would be read by a re-driven turn that never
 * happened; the abort's error bubble must not precede the record of the turn it
 * ended; and the pivot write is deliberately replay-safe so restart recovery
 * can redo it.
 *
 * It is also the ONLY place an abort or suspend from afterModelCall /
 * afterToolExecution is counted — beforeTurn has its own two exits
 * (nudges.ts middlewareAbortResult, suspension.ts suspendedTurn) and never
 * reaches here. Everything loud that a guard does mid-turn lands in this
 * function: loop-detection / repeat-output aborting after the model call,
 * repeat-failure / thrash-guard aborting or suspending after tool execution,
 * the idle-watchdog suspending a stalled worker.
 */
import type { Op } from "../../ops/types.js";
import type { MiddlewareDirective } from "./types.js";
import type { emitErrorOnce } from "../event-emitter.js";
import type { appendNudgeAsUserMessage, recoverCommittedStrategyPivot } from "./nudges.js";
import { directiveFire, recordGuardFire } from "./guard-fire.js";

/** The write seams driveTurn owns, passed in so its `deps` overrides (used by
 *  turn-loop.test.ts) still reach them instead of being bypassed by a direct
 *  module import here. */
export interface DirectiveEffects {
  appendNudgeAsUserMessage: typeof appendNudgeAsUserMessage;
  recoverCommittedStrategyPivot: typeof recoverCommittedStrategyPivot;
  emitErrorOnce: typeof emitErrorOnce;
}

export function applyCommittedDirective(
  op: Op,
  turnIdx: number,
  directive: MiddlewareDirective,
  fx: DirectiveEffects,
): void {
  if (directive.kind === "nudge") {
    // Pivots go through the deterministic-id path so a restart re-materializes
    // them exactly once; both branches count the fire inside nudges.ts, on the
    // one code path that actually writes the row.
    if (directive.metadata?.strategyPivot) fx.recoverCommittedStrategyPivot(op.id, turnIdx);
    else fx.appendNudgeAsUserMessage(op.id, turnIdx + 1, directive.message, directiveFire(directive), directive.metadata);
    return;
  }
  if (directive.kind === "abort") {
    // Count only when the bubble is actually emitted. emitErrorOnce collapses a
    // repeat of the same abort, and an unconditional emit beside it would also
    // flush chat-runner/event-pump.ts's held `aborted` acknowledgement — the
    // user would see "aborted" AND the cause instead of the cause alone.
    const bubbled = fx.emitErrorOnce(op.id, {
      code: "middleware-abort",
      message: directive.message ?? `Turn aborted by ${directive.firedBy}.`,
      retryable: false,
    });
    if (bubbled) recordGuardFire(op.id, turnIdx, directiveFire(directive));
    return;
  }
  // suspend — worker.ts parks the op as `paused`. That transition records the
  // state, not the guard, so this is the only record of WHICH guard paused it.
  recordGuardFire(op.id, turnIdx, directiveFire(directive));
}
