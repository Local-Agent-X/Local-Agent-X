/**
 * turn_loop — the inner per-turn driver (PRD §5 / §15).
 *
 * driveTurn is the turn's sequence of steps; each step is a call into the
 * module named after its job (all under ./turn-loop/):
 *   1. recover a committed pivot      nudges.ts recoverCommittedStrategyPivot
 *   2. snapshot the redirect, emit    build-input.ts readPendingRedirect
 *      `turn_started`
 *   3. drain mid-turn injects         inject-drain.ts
 *   4. beforeTurn middlewares         middleware-phases.ts
 *   5. assemble the turn input        build-input.ts (+ compact-history.ts)
 *   6. the model call                 model-call.ts (idle-watchdog.ts, the
 *                                     adapter-throw / reported-error recovery)
 *   7. afterModelCall middlewares     middleware-phases.ts
 *   8. tool dispatch                  dispatch-tools.ts
 *   9. afterToolExecution middlewares middleware-phases.ts
 *  10. decide the outcome             decide-outcome.ts (+ its gates)
 *  11. commit the turn                commit-input.ts → checkpoint.ts commitTurn
 *  12. what waits for the commit      after-commit.ts (skill review, app
 *                                     snapshot, earned fires, the directive)
 * with a cancel check after the model call, after dispatch, and after the
 * outcome decision: a cancel discards the partial turn.
 *
 * Boundary rules:
 *   - The loop never executes tools itself — every tool round-trip goes
 *     through the canonical tool-dispatcher boundary (dispatch-tools.ts).
 *   - The loop never writes `op_events` directly — every event goes through
 *     `emit()`.
 *   - The adapter never writes anything; it only emits adapter_report items
 *     through the report callback.
 *
 * Behaviour belongs in the step modules, never here. Every collaborator is
 * reached through turn-loop/turn-deps.ts so the sequence is testable without
 * vi.mock (turn-loop.test.ts).
 */
import type { Adapter } from "./adapter-contract.js";
import type { CommitTurnMessage } from "./checkpoint.js";
import type { Op } from "../ops/types.js";
import type { DriveTurnResult, DriveTurnOptions, MiddlewareDirective } from "./turn-loop/types.js";
import { resolveTurnLoopDeps, type TurnLoopDeps } from "./turn-loop/turn-deps.js";
import { runModelCall, modelCallSignals } from "./turn-loop/model-call.js";
import { commitTurnInput } from "./turn-loop/commit-input.js";
import { createTurnMiddlewarePhases, directiveSkipsToolDispatch } from "./turn-loop/middleware-phases.js";
import { runAfterCommit } from "./turn-loop/after-commit.js";
import { elapsedMs, monotonicNow } from "./elapsed.js";

export type { DriveTurnResult, DriveTurnOptions } from "./turn-loop/types.js";
export type { TurnLoopDeps } from "./turn-loop/turn-deps.js";
export async function driveTurn(
  op: Op,
  adapter: Adapter,
  turnIdx: number,
  opts: DriveTurnOptions = {},
  depsIn: TurnLoopDeps = {},
): Promise<DriveTurnResult> {
  // Collaborator seams — absent overrides resolve to the concrete module
  // functions, read here (per call, never hoisted) so runtime-mutable state
  // (middleware stack, idle-timeout config) is still current per turn. Each
  // step module below takes the slice of these it calls, so a test override
  // reaches it too.
  const deps = resolveTurnLoopDeps(depsIn);

  // Recover a preceding committed pivot before composing this turn.
  deps.recoverCommittedStrategyPivot(op.id, turnIdx - 1);

  // Snapshot the redirect column from disk BEFORE emitting `turn_started`.
  // The bus dispatch is synchronous, so a `turn_started` subscriber that
  // calls `opRedirect` lands on disk AFTER this read — meaning a redirect
  // arriving during this turn applies to the NEXT turn (PRD acceptance #5:
  // mid-turn redirect → next-turn application). A redirect that arrived
  // BEFORE the worker entered driveTurn is captured here and folded into
  // this turn's prompt.
  const pendingRedirect = deps.readPendingRedirect(op.id);
  deps.emit(op.id, "turn_started", { turnIdx });

  // Mid-turn injects: messages the user typed during a previous turn / tool
  // call, queued by chat-ws via pushInject(). Drain into op_messages BEFORE
  // buildTurnInput so the adapter sees them inline as user messages on this
  // turn. Mirrors agent-loop's interjectDrainMiddleware. Gated to op types
  // that consume injects (chat_turn + agent_spawn) so background workers
  // sharing the user's session don't drain the user's chat-bound injects;
  // agent_spawn runs on its own private session so this only delivers
  // inter-agent messages bridged onto it.
  if (deps.opConsumesInjects(op.type)) deps.drainInjectsIntoTurn(op, turnIdx);

  // ── Phase 1: beforeTurn middlewares ── (abort / suspend end the turn here)
  const phases = createTurnMiddlewarePhases(op, turnIdx, deps);
  const beforeTurnEnd = await phases.beforeTurn();
  if (beforeTurnEnd) return beforeTurnEnd;

  const input = await deps.buildTurnInput(op, turnIdx, pendingRedirect);

  const modelCall = await runModelCall(op, adapter, input, turnIdx, deps);
  if (modelCall.kind === "ended") return modelCall.turnResult;
  const { call } = modelCall;

  // Cancel-aware bail BEFORE tool dispatch and BEFORE commit. The adapter
  // has already returned (via abort or natural completion); the worker's
  // cancel handler is in charge of the running→cancelling→cancelled
  // transitions, and we must not commit a partial turn.
  if (opts.isCancelled?.()) return cancelledTurn(0);

  // ── Phase 2: afterModelCall middlewares ── (the first sticky directive)
  let middlewareDirective = await phases.afterModelCall(call);
  const toolDispatchStart = monotonicNow();
  const { toolMessages, toolSummary } = directiveSkipsToolDispatch(middlewareDirective)
    ? { toolMessages: [] as CommitTurnMessage[], toolSummary: [] }
    : await deps.dispatchTools(op.id, turnIdx, call.toolCalls, opts.isCancelled);
  const toolDispatchMs = elapsedMs(toolDispatchStart);
  if (opts.isCancelled?.()) return cancelledTurn(toolSummary.length);

  // ── Phase 3: afterToolExecution middlewares ── (only when no directive yet)
  middlewareDirective ??= await phases.afterToolExecution(call, toolMessages, toolSummary);

  // Decide terminal reason + assemble the commit-message list, running the
  // retract / failure-nudge / continuation-guard / render-verify side
  // effects. See turn-loop/decide-outcome.ts.
  const outcome = await deps.decideTurnOutcome({
    op, turnIdx, middlewareDirective, toolMessages, toolSummary, ...modelCallSignals(call),
  });

  // Cancel-aware bail AFTER decideTurnOutcome, BEFORE commit: a Stop during its
  // seconds–minutes verify gates flips the op to `cancelling`, which commitTurn
  // would throw on (illegal cancelling→succeeded) and wedge the op.
  if (opts.isCancelled?.()) return cancelledTurn(toolSummary.length);

  const learningSessionId = outcome.terminalOutcome ? deps.resolveLearningSessionId(op) : null;
  deps.commitTurn(commitTurnInput({
    op, leaseClaim: opts.leaseClaim, turnIdx, input, pendingRedirect, call,
    toolSummary, toolDispatchMs, directive: middlewareDirective, outcome, learningSessionId,
  }));
  runAfterCommit({
    op, turnIdx, learningSessionId, toolCalls: call.toolCalls, earnedFires: outcome.earnedFires, directive: middlewareDirective,
  }, deps);

  return {
    terminalReason: outcome.terminalReason,
    toolCount: toolSummary.length,
    messageCount: outcome.allMessages.length,
    cancelled: false,
    middlewareDirective: middlewareDirective ? reportedDirective(middlewareDirective) : undefined,
  };
}

/** A cancel discards the partial turn: no commitTurn, no op_turns row, no
 *  op_messages, no turn_committed event (PRD §13). */
function cancelledTurn(toolCount: number): DriveTurnResult {
  return { terminalReason: null, toolCount, messageCount: 0, cancelled: true };
}

/** The directive as the worker reads it: a nudge keeps it looping, an abort
 *  ends the op, a suspend parks it (DriveTurnResult.middlewareDirective). */
function reportedDirective(directive: MiddlewareDirective): NonNullable<DriveTurnResult["middlewareDirective"]> {
  return { kind: directive.kind, reason: directive.reason, firedBy: directive.firedBy, message: directive.message };
}
