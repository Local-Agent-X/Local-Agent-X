/**
 * The guard fire counter — the ONE place `middleware_fired` is minted.
 *
 * The harness steers the model with ~30 behavioral guards (middlewares plus
 * completion gates) and, before this event, counted none of them:
 * canonical-events.jsonl carried 16 event types across 2,478 persisted ops and
 * not one was a guard firing, so a fire count could only be recovered by
 * string-matching nudge PROSE in op_messages — a record that rewording a nudge
 * silently destroys. Guards get retired on this evidence (2026-07-10), so an
 * uncounted path reads as a dead guard. Hence the exhaustive ledger below.
 *
 * COUNTED — a guard whose verdict took effect on the op:
 *   nudge    a middleware or completion-gate nudge that actually reached
 *            op_messages (nudges.ts). One suppressed by `stableMessageId` is a
 *            replay of an already-counted fire, not a new one.
 *   abort    beforeTurn (nudges.ts middlewareAbortResult) AND
 *            afterModelCall / afterToolExecution (apply-directive.ts) — the
 *            second path is where loop-detection, repeat-output, repeat-failure
 *            and thrash-guard actually end a turn. Both count only when the
 *            abort's error bubble is really emitted: emitErrorOnce collapses a
 *            repeat of the same abort, and the count collapses with it.
 *   suspend  beforeTurn (suspension.ts) and the later phases plus the
 *            idle-watchdog (apply-directive.ts). This is the autonomous lane's
 *            pause — repeat-failure and thrash-guard suspend instead of
 *            aborting on worker lanes, and nothing else records it.
 *   rewrite  a guard that edits the model's tool call instead of speaking
 *            (office-theme-guard strips an uninvited `theme`).
 *
 * NOT COUNTED — read a 0 with these in mind:
 *   - a `continue` verdict: a guard that looked and let the turn pass.
 *   - a completion gate that ACTS WITHOUT NUDGING: late-inject re-opening the
 *     turn, framework-serve registering a dev server, render-verify's
 *     capReached, build-verify's verifiedClean confirmation. Counting those is
 *     a semantics expansion ("acted" vs "spoke") deliberately not made here.
 *   - a directive discarded by a user cancel: driveTurn bails before the
 *     post-commit apply, so the verdict never reached the op.
 *
 * `turnIdx` is the turn the effect LANDS on, not the turn under judgment: a
 * next-turn nudge files under turnIdx + 1, an abort/suspend under the turn it
 * stopped, an honest terminal under the turn it ends.
 */
import { emit } from "../event-emitter.js";
import type { MiddlewareFiredBody } from "../types.js";
import type { MiddlewareDirective } from "./types.js";

/** The `{ name, reason }` half of MiddlewareFiredBody — the turnIdx half is
 *  supplied by whoever applies the fire. Required wherever a guard can speak,
 *  so a nudge cannot reach op_messages unnamed. */
export interface GuardFire {
  name: string;
  reason: string;
}

/** Persist one fire. The body shape lives here and nowhere else. */
export function recordGuardFire(opId: string, turnIdx: number, fire: GuardFire): void {
  const body: MiddlewareFiredBody = { name: fire.name, reason: fire.reason, turnIdx };
  emit(opId, "middleware_fired", body);
}

/** A sticky directive already carries its firer's name (turn-loop.ts stamps it). */
export function directiveFire(directive: MiddlewareDirective): GuardFire {
  return { name: directive.firedBy, reason: directive.reason };
}

/** A phase verdict straight off the middleware host. `firedBy` is always set on
 *  a non-`continue` result (middlewares/host.ts stamps `mw.name` on every one);
 *  the fallback exists ONLY because the type keeps the field optional for the
 *  `continue` case, and is not a reachable code path. */
export function firedResultFire(result: { firedBy?: string; reason: string }): GuardFire {
  return { name: result.firedBy ?? "unknown", reason: result.reason };
}
