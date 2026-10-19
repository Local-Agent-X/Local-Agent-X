/**
 * turn_loop — the inner per-turn driver (PRD §5 / §15).
 *
 * Assembles history, runs the adapter and canonical dispatcher, then commits
 * the finalized turn.
 *
 * Tools, events, and persistence stay behind their canonical boundaries;
 * adapters only emit reports.
 */
import type { Adapter } from "./adapter-contract.js";
import type { ProviderStateEnvelope } from "./types.js";
import type { CommitTurnMessage } from "./checkpoint.js";
import type { Op } from "../ops/types.js";
import type { DriveTurnResult, DriveTurnOptions } from "./turn-loop/types.js";
import { resolveTurnLoopDeps, type TurnLoopDeps } from "./turn-loop/turn-deps.js";
import { runModelCall, modelCallSignals } from "./turn-loop/model-call.js";
import { createTurnMiddlewarePhases, directiveSkipsToolDispatch } from "./turn-loop/middleware-phases.js";
import { applyCommittedDirective } from "./turn-loop/apply-directive.js";
import { bankEarnedFires } from "./turn-loop/guard-fire.js";

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
  // (middleware stack, idle-timeout config) is still current per turn. Same
  // names as the imports they default to; the body below is unchanged.
  const {
    emit, emitErrorOnce, publishStreamChunk, commitTurn, runMiddlewarePhase,
    extractText, extractToolResultText, buildToolResultsView, appendNudgeAsUserMessage,
    recoverCommittedStrategyPivot,
    middlewareAbortResult, buildTurnInput, readPendingRedirect,
    drainInjectsIntoTurn, opConsumesInjects, dispatchTools, createIdleWatchdog,
    readIdleTimeoutMs, snapshotTouchedApps, decideTurnOutcome,
    createTurnContextComposer, resolveLearningSessionId, requestSkillReviewForOp,
  } = resolveTurnLoopDeps(depsIn);

  // Recover a preceding committed pivot before composing this turn.
  recoverCommittedStrategyPivot(op.id, turnIdx - 1);

  // Snapshot the redirect column from disk BEFORE emitting `turn_started`.
  // The bus dispatch is synchronous, so a `turn_started` subscriber that
  // calls `opRedirect` lands on disk AFTER this read — meaning a redirect
  // arriving during this turn applies to the NEXT turn (PRD acceptance #5:
  // mid-turn redirect → next-turn application). A redirect that arrived
  // BEFORE the worker entered driveTurn is captured here and folded into
  // this turn's prompt.
  const pendingRedirect = readPendingRedirect(op.id);
  emit(op.id, "turn_started", { turnIdx });

  // Mid-turn injects: messages the user typed during a previous turn / tool
  // call, queued by chat-ws via pushInject(). Drain into op_messages BEFORE
  // buildTurnInput so the adapter sees them inline as user messages on this
  // turn. Mirrors agent-loop's interjectDrainMiddleware. Gated to op types
  // that consume injects (chat_turn + agent_spawn) so background workers
  // sharing the user's session don't drain the user's chat-bound injects;
  // agent_spawn runs on its own private session so this only delivers
  // inter-agent messages bridged onto it.
  if (opConsumesInjects(op.type)) drainInjectsIntoTurn(op, turnIdx);

  // ── Phase 1: beforeTurn middlewares ── (abort / suspend end the turn here)
  const phases = createTurnMiddlewarePhases(op, turnIdx, {
    createTurnContextComposer, runMiddlewarePhase, middlewareAbortResult,
    appendNudgeAsUserMessage, buildToolResultsView, extractToolResultText,
  });
  const beforeTurnEnd = await phases.beforeTurn();
  if (beforeTurnEnd) return beforeTurnEnd;

  const input = await buildTurnInput(op, turnIdx, pendingRedirect);

  const modelCall = await runModelCall(op, adapter, input, turnIdx, { emit, publishStreamChunk, createIdleWatchdog, readIdleTimeoutMs, extractText });
  if (modelCall.kind === "ended") return modelCall.turnResult;
  const { call } = modelCall;
  const { result, toolCalls, observedTools, assistantText, modelMs } = call;

  // Cancel-aware bail BEFORE tool dispatch and BEFORE commit. The adapter
  // has already returned (via abort or natural completion); the worker's
  // cancel handler is in charge of the running→cancelling→cancelled
  // transitions, and we must not commit a partial turn.
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: true };
  }

  // ── Phase 2: afterModelCall middlewares ── (the first sticky directive)
  let middlewareDirective = await phases.afterModelCall(call);
  const toolDispatchStart = Date.now();
  const { toolMessages, toolSummary } = directiveSkipsToolDispatch(middlewareDirective)
    ? { toolMessages: [] as CommitTurnMessage[], toolSummary: [] }
    : await dispatchTools(op.id, turnIdx, toolCalls, opts.isCancelled);
  const toolDispatchMs = Date.now() - toolDispatchStart;
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: toolSummary.length, messageCount: 0, cancelled: true };
  }

  // ── Phase 3: afterToolExecution middlewares ── (only when no directive yet)
  middlewareDirective ??= await phases.afterToolExecution(call, toolMessages, toolSummary);

  // Stamp the compacted-view marker from buildTurnInput onto the envelope
  // being committed — an EXPLICIT boolean on every turn, not just true on
  // compacted ones. The stamp doubles as an era marker: rows without the
  // boolean predate reliable recording (pre-stamp compactions, pre-2026-06-26
  // observedTools gaps) and lastTurnUsage refuses to anchor on them. Adapters
  // never set it; without the stamp the next turn would anchor context sizing
  // on usage that measured the compacted view against the full replay
  // (see ProviderStateEnvelope.viewCompacted).
  const providerState: ProviderStateEnvelope = {
    ...result.providerState,
    viewCompacted: input.viewCompacted === true,
  };
  const middlewareAborted = middlewareDirective?.kind === "abort";

  // Decide terminal reason + assemble the commit-message list, running the
  // retract / failure-nudge / continuation-guard / render-verify side
  // effects. See turn-loop/decide-outcome.ts.
  const { terminalReason, allMessages, terminalOutcome, earnedFires } = await decideTurnOutcome({
    op,
    turnIdx,
    middlewareDirective,
    toolMessages,
    toolSummary,
    ...modelCallSignals(call),
  });

  // Cancel-aware bail AFTER decideTurnOutcome, BEFORE commit: a Stop during its
  // seconds–minutes verify gates flips the op to `cancelling`, which commitTurn
  // would throw on (illegal cancelling→succeeded) and wedge the op.
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: toolSummary.length, messageCount: 0, cancelled: true };
  }

  const learningSessionId = terminalOutcome ? resolveLearningSessionId(op) : null;
  commitTurn({
    op,
    leaseClaim: opts.leaseClaim,
    turnIdx,
    providerState,
    messages: allMessages,
    toolCallSummary: toolSummary,
    observedTools,
    terminalReason,
    redirectConsumed: pendingRedirect != null,
    redirectInstructionId: pendingRedirect?.instructionId,
    redirectText: pendingRedirect?.text,
    modelMs,
    toolDispatchMs,
    trace: result.trace,
    learnedOutcome: terminalOutcome ?? undefined,
    learningSessionId: learningSessionId ?? undefined,
    // A middleware abort's note is the op's failure reason (commitTurn stamps it at the failed transition).
    failureReason: middlewareAborted ? (middlewareDirective!.message?.trim() || `Turn aborted by ${middlewareDirective!.firedBy}.`) : undefined,
    nextTurnPivot: middlewareDirective?.kind === "nudge" && middlewareDirective.metadata?.strategyPivot
      ? { message: middlewareDirective.message, firedBy: middlewareDirective.firedBy, metadata: { strategyPivot: middlewareDirective.metadata.strategyPivot } }
      : undefined,
  });
  if (learningSessionId) requestSkillReviewForOp(op, learningSessionId, turnIdx); // post-commit ONLY — see record-outcome.ts

  // Tier 1.C: per-turn snapshot of any app files this turn wrote/edited.
  // Powers the IDE topbar's ↺ Revert dropdown so the user can undo a bad
  // edit without asking the agent to fix what it just broke.
  void snapshotTouchedApps(toolCalls, turnIdx);

  // Fires earned inside decideTurnOutcome. Banked HERE because the message each
  // describes lived only in `allMessages` until commitTurn above, with the
  // cancel bail in between — same ordering contract as the records below.
  bankEarnedFires(op.id, turnIdx, earnedFires);

  // Nudge materialization, the abort bubble and the abort/suspend fire records
  // all wait for the durable turn — see apply-directive.ts for that ordering
  // contract. A cancel bails above, so a discarded directive is never applied.
  if (middlewareDirective) {
    applyCommittedDirective(op, turnIdx, middlewareDirective, { appendNudgeAsUserMessage, recoverCommittedStrategyPivot, emitErrorOnce });
  }

  return {
    terminalReason,
    toolCount: toolSummary.length,
    messageCount: allMessages.length,
    cancelled: false,
    middlewareDirective: middlewareDirective
      ? {
          kind: middlewareDirective.kind,
          reason: middlewareDirective.reason,
          firedBy: middlewareDirective.firedBy,
          message: middlewareDirective.message,
        }
      : undefined,
  };
}
