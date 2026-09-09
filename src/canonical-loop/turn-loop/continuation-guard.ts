/**
 * The unified continuation guard — the pre-commit half of "is the worker going
 * to keep looping past this turn?".
 *
 * Whenever it is (a middleware nudge appended at turn+1, decide-outcome's own
 * failure-detection nudge, or a mid-turn user inject sitting in the chat
 * queue), commitTurn MUST NOT call transitionOp(succeeded): the next turn will
 * also resolve as done and the second succeeded → succeeded transition is
 * illegal, surfacing as a worker_exception in chat (bug screenshot 2026-05-23,
 * a game-loop fix that landed while the user saw a confusing red error). The
 * worker's resume-gate logic mirrors these same three conditions.
 *
 * Pure extraction from decide-outcome.ts, which had reached the hard 400-LOC
 * source-hygiene ceiling (scripts/check-source-hygiene.mjs, MAX_LOC 400,
 * GRANDFATHERED empty) that its own header commits it to splitting BEFORE, as
 * decide-outcome-gates.ts, decide-outcome-run-gates.ts and
 * empty-turn-termination.ts each already did. decide-outcome.ts still owns the
 * terminal decision: this answers one yes/no question about it.
 *
 * THE GATE-CHAIN RELATIONSHIP. This runs BEFORE the completion gates, and a
 * veto here sets terminalReason=null, which stops the chain from being entered
 * at all. So its inject branch and lateInjectGate's are mutually exclusive
 * halves of ONE effect, split purely by when the follow-up arrived: already
 * queued (here) versus landing during the async verify gates (there). Counted
 * under different names for a reason guard-fire.ts states.
 */
import { hasInjects, opConsumesInjects } from "../../agent-loop/inject-queue.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { CONTINUATION_INJECT_FIRE, type GuardFire } from "./guard-fire.js";
import type { MiddlewareDirective } from "./types.js";
import type { Op } from "../../ops/types.js";

/**
 * True when the worker will drive another turn, so this turn's "done" must be
 * withdrawn. Call ONLY on a turn that is provisionally "done".
 *
 * `earnedFires` is appended to in place, for the ONE branch that acts silently.
 * The other two SPOKE — appendNudgeAsUserMessage already wrote a `nudge` row
 * for the middleware directive and for the tool-failure summary — and a
 * `reopen` beside those would count one landed message twice.
 *
 * The fire is EARNED, not minted here: this veto's entire effect is an
 * in-memory `terminalReason = null` on its way to a commitTurn that driveTurn's
 * cancel bail can still skip, so a row written now would assert a turn that
 * never committed. turn-loop.ts banks the list past that bail
 * (guard-fire.ts bankEarnedFires).
 */
export function continuationVetoedTerminal(
  op: Op,
  middlewareDirective: MiddlewareDirective | null,
  failureNudged: boolean,
  earnedFires: GuardFire[],
): boolean {
  // The two SPEAKING branches, first and short-circuiting. Not an optimisation:
  // `reopen` means the terminal was vetoed and the model told NOTHING
  // (types.ts GuardOutcome), so on a turn that also carries a nudge the silent
  // row would be false on its face. Same rule that keeps a re-opening GATE's
  // nudge from also filing a `reopen`, and the chain runner gets it for free —
  // an earlier gate's nudge short-circuits the chain before late-inject
  // evaluates. Both reads below are pure, so the skip changes no behavior.
  if (middlewareDirective?.kind === "nudge" || failureNudged) return true;
  // Only inject-consuming ops (chat_turn + agent_spawn) drain injects into
  // their next turn (see turn-loop.ts drainInjectsIntoTurn and
  // inject-queue.ts opConsumesInjects). A freeform / delegated op sharing a
  // session with pending chat injects must NOT extend itself waiting for
  // them — the injects belong to the consuming worker. Without this gate,
  // "non-consuming ops do NOT drain the queue" was accidentally upgraded to
  // "non-consuming ops hang forever whenever an inject is queued on the same
  // session."
  const sessionId = getSessionForOp(op.id);
  const injectsPending = opConsumesInjects(op.type) && sessionId ? hasInjects(sessionId) : false;
  if (injectsPending) earnedFires.push(CONTINUATION_INJECT_FIRE);
  return injectsPending;
}
