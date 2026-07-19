/**
 * turn_loop — the inner per-turn driver (PRD §5 / §15).
 *
 * Assembles history, runs the adapter and canonical dispatcher, then commits
 * the finalized turn.
 *
 * Tools, events, and persistence stay behind their canonical boundaries;
 * adapters only emit reports.
 */
import type { Adapter, AdapterReport, TurnResult } from "./adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "./contract-types.js";
import type { ProviderStateEnvelope } from "./types.js";
import type { CommitTurnMessage } from "./checkpoint.js";
import type { Op } from "../ops/types.js";
import type { DriveTurnResult, DriveTurnOptions, MiddlewareDirective } from "./turn-loop/types.js";
import { resolveTurnLoopDeps, type TurnLoopDeps } from "./turn-loop/turn-deps.js";
import { recoverAdapterThrow, clearAdapterThrowStreak } from "./turn-loop/adapter-throw-recovery.js";
import { recoverReportedAdapterError } from "./turn-loop/reported-adapter-recovery.js";
import { idleSuspension, middlewareSuspension, suspendedTurn } from "./turn-loop/suspension.js";

export type { DriveTurnResult, DriveTurnOptions } from "./turn-loop/types.js";
export type { TurnLoopDeps } from "./turn-loop/turn-deps.js";
// Consecutive THROWN adapter errors per op — provider hangs/timeouts the
// adapter couldn't convert into a kind:"error" report. Bounds the feed-back-
// and-continue recovery (below) so a hard-down provider gives up after a few
// stalls instead of spinning the op's whole wall-clock budget (2h on a chat
// turn). In-memory by design: a worker crash/recovery resets the count, and
// op recovery has its own bound (heartbeat.ts retryPolicy). Cleared on any
// successful model call and when the cap is hit.
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
    createTurnContextComposer, resolveLearningSessionId,
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

  // ── Phase 1: beforeTurn middlewares ──
  // Snapshot a fresh CanonicalLoopContext from disk + op state. A `nudge`
  // here appends a synthetic user message at the CURRENT turnIdx so this
  // turn's adapter sees it (mirrors agent-loop's beforeIteration→push-then-
  // restart-iteration). An `abort` short-circuits the whole turn — no
  // adapter call, no tool dispatch — and the worker exits.
  const contextComposer = createTurnContextComposer(op, turnIdx);
  const { middlewareStack } = contextComposer;
  const beforeCtx = contextComposer.build();
  const beforeRes = await runMiddlewarePhase(beforeCtx, "beforeTurn", middlewareStack);
  if (beforeRes.kind === "abort") {
    return middlewareAbortResult(op, turnIdx, beforeRes);
  }
  const beforeSuspension = suspendedTurn(beforeRes);
  if (beforeSuspension) return beforeSuspension;
  if (beforeRes.kind === "nudge") {
    appendNudgeAsUserMessage(op.id, turnIdx, beforeRes.message, beforeRes.metadata);
    // Fall through — next read of op_messages (buildTurnInput, below) picks
    // the nudge up and ships it to the adapter on this turn.
  }

  const input = await buildTurnInput(op, turnIdx, pendingRedirect);

  const finalized: CanonicalMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const observedTools: string[] = [];
  // `heartbeat` = reasoning model streaming chain-of-thought (adapter-contract.ts).
  let sawReasoning = false;
  let sawStreamContent = false;
  let adapterError: { code: string; message: string; retryable: boolean } | null = null;
  let middlewareDirective: MiddlewareDirective | null = null;

  // Idle-event detection — provider-agnostic. Watches the report stream
  // for ANY activity (stream chunks, tool calls, finalized messages,
  // errors). If nothing arrives for idleMs the adapter is assumed stuck
  // and we abort with reason "idle-stalled" so transports that recognize
  // it (warm-pool's reason matcher) can hard-kill the underlying CLI/HTTP
  // connection. Lives behind a shared watchdog so any future adapter
  // (xai, gemini, local) inherits it.
  let idleFired = false;
  const idleMs = readIdleTimeoutMs();
  const watchdog = createIdleWatchdog({
    idleMs,
    onTimeout: () => {
      idleFired = true;
      adapterError = { code: "stalled", message: `no adapter reports for ${idleMs}ms — model presumed stuck`, retryable: false };
      // Fire-and-forget — don't await; runTurn may still need a beat to
      // unwind. The reason propagates through the abort signal so
      // transports that watch reason (warm-pool kill on /idle|stalled|stop/)
      // do the right thing.
      void adapter.abort(new Error("idle-stalled"));
    },
  });

  // Time-component split for soak: how much of the turn was spent inside
  // the adapter's model call vs dispatching tools. Together with
  // commitMs (small, not separately tracked) and any caller-side prep,
  // they reconstruct where the turn's wall-clock went.
  const modelStart = Date.now();
  let result: TurnResult;
  try {
    result = await adapter.runTurn(input, (r: AdapterReport) => {
      watchdog.noteActivity();
      if (r.kind === "heartbeat") { sawReasoning = true; return; }
      if (r.kind === "reasoning_chunk") {
        // Live chain-of-thought. Rides the same ephemeral stream bus as text
        // (bus-only, never persisted) with a `reasoning` marker so the pump
        // maps it to a `reasoning` ServerEvent instead of answer text.
        sawReasoning = true;
        sawStreamContent = true;
        publishStreamChunk(op.id, { reasoning: true, delta: r.delta });
        return;
      }
      if (r.kind === "stream_chunk") {
        sawStreamContent = true;
        publishStreamChunk(op.id, r.body);
        return;
      }
      if (r.kind === "stream_redact") {
        // The adapter post-processed its already-streamed text (e.g.
        // tool-call extraction) and wants the UI to retract part of it.
        // Re-uses the stream-chunk publish path with a `replace: true`
        // marker so the client can swap the bubble's text rather than
        // append.
        publishStreamChunk(op.id, { replace: true, text: r.replacementText });
        return;
      }
      if (r.kind === "message_finalized") {
        finalized.push(r.message);
        return;
      }
      if (r.kind === "tool_call_requested") {
        toolCalls.push(r.call);
        return;
      }
      if (r.kind === "tool_observed") {
        observedTools.push(r.tool);
        return;
      }
      if (r.kind === "error") {
        adapterError = { code: r.code, message: r.message, retryable: r.retryable };
        emit(op.id, "error", { code: r.code, message: r.message, retryable: r.retryable });
      }
    });
  } catch (e) {
    // Thrown (unreported) adapter error — see adapter-throw-recovery.ts.
    watchdog.disarm();
    return recoverAdapterThrow(op, e, turnIdx);
  }
  watchdog.disarm();
  // A model call that actually returned (success, or a reported kind:"error")
  // breaks the THROWN-error streak — the provider is responding again.
  clearAdapterThrowStreak(op.id);
  // A REPORTED over-window error (adapter converted the provider's
  // context_overflow/413 into kind:"error" instead of throwing) gets the same
  // forced-compact-and-retry as the thrown path — without this it would ride
  // adapterError straight to terminal "error" and kill the op. Bounded by the
  // recovery's own attempt cap; success clears the counter below.
  // (read via a typed local: adapterError is assigned inside the stream
  // callback, which TS's narrowing can't see — it types the direct read `never`)
  const reportedError = adapterError as { code: string; message: string; retryable: boolean } | null;
  const recoveredReport = recoverReportedAdapterError(op, reportedError, turnIdx, {
    streamed: sawStreamContent, finalized: finalized.length,
    toolCalls: toolCalls.length, observedTools: observedTools.length,
  });
  if (recoveredReport) return recoveredReport;
  void idleFired; // surfaced via adapterError; reserved for telemetry
  const modelMs = Date.now() - modelStart;

  // Cancel-aware bail BEFORE tool dispatch and BEFORE commit. The adapter
  // has already returned (via abort or natural completion); the worker's
  // cancel handler is in charge of the running→cancelling→cancelled
  // transitions, and we must not commit a partial turn.
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: true };
  }

  // ── Phase 2: afterModelCall middlewares ──
  // Build a fresh context view from this turn's emitted assistant text +
  // tool calls. Middlewares may MUTATE ctx.toolCalls (auto-build-app
  // appends a synthetic build_app call) — we use the same array reference
  // turn-loop will dispatch from, so any synthetic call lands in the
  // toolCalls list before dispatchTools fires.
  const assistantText = finalized
    .filter(m => m.role === "assistant")
    .map(m => extractText(m.content))
    .join("");
  const afterModelCtx = contextComposer.build({
    toolCalls,
    assistantContent: assistantText,
  });
  // Wire the live toolCalls array so auto-build-app's push mutates the
  // dispatcher's input. buildCanonicalLoopContext already passes it; this
  // is documentation for the next reader.
  afterModelCtx.toolCalls = toolCalls;
  // Thread this turn's REAL reasoning/usage signals so post-turn-detector can
  // tell a reasoning-burn turn from a genuinely empty one (HE-5).
  const usageOut = (result.providerState?.providerPayload as { usageOutputTokens?: unknown } | undefined)?.usageOutputTokens;
  afterModelCtx.hasReasoning = sawReasoning;
  afterModelCtx.completionTokens = typeof usageOut === "number" ? usageOut : undefined;
  const afterModelRes = await runMiddlewarePhase(afterModelCtx, "afterModelCall", middlewareStack);
  if (afterModelRes.kind === "abort") {
    middlewareDirective = {
      kind: "abort",
      reason: afterModelRes.reason,
      firedBy: afterModelRes.firedBy ?? "unknown",
      message: afterModelRes.message,
    };
  } else if (afterModelRes.kind === "nudge") {
    middlewareDirective = {
      kind: "nudge",
      reason: afterModelRes.reason,
      firedBy: afterModelRes.firedBy ?? "unknown",
      message: afterModelRes.message,
      metadata: afterModelRes.metadata,
      skipToolDispatch: afterModelRes.skipToolDispatch,
    };
  } else {
    middlewareDirective = middlewareSuspension(afterModelRes);
  }
  middlewareDirective ??= idleSuspension(op.lane, reportedError);
  const toolDispatchStart = Date.now();
  const skipToolDispatch = middlewareDirective?.kind === "abort"
    || (middlewareDirective?.kind === "nudge" && middlewareDirective.skipToolDispatch === true);
  const { toolMessages, toolSummary } = skipToolDispatch
    ? { toolMessages: [] as CommitTurnMessage[], toolSummary: [] }
    : await dispatchTools(op.id, turnIdx, toolCalls, opts.isCancelled);
  const toolDispatchMs = Date.now() - toolDispatchStart;
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: toolSummary.length, messageCount: 0, cancelled: true };
  }

  // ── Phase 3: afterToolExecution middlewares ──
  // Only run when an abort hasn't already short-circuited the turn. The
  // first non-continue verdict from afterModelCall wins; afterToolExecution
  // only refines (not overrides) — matches agent-loop's per-phase ordering.
  if (middlewareDirective === null) {
    const toolResultsView = buildToolResultsView(toolMessages, toolSummary, extractToolResultText);
    const afterToolCtx = contextComposer.build({
      toolCalls,
      toolResults: toolResultsView,
      assistantContent: assistantText,
    });
    const afterToolRes = await runMiddlewarePhase(afterToolCtx, "afterToolExecution", middlewareStack);
    if (afterToolRes.kind === "abort") {
      middlewareDirective = {
        kind: "abort",
        reason: afterToolRes.reason,
        firedBy: afterToolRes.firedBy ?? "unknown",
        message: afterToolRes.message,
      };
    } else if (afterToolRes.kind === "nudge") {
      middlewareDirective = {
        kind: "nudge",
        reason: afterToolRes.reason,
        firedBy: afterToolRes.firedBy ?? "unknown",
        message: afterToolRes.message,
        metadata: afterToolRes.metadata,
        skipToolDispatch: afterToolRes.skipToolDispatch,
      };
    } else {
      middlewareDirective = middlewareSuspension(afterToolRes);
    }
  }

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
  const { terminalReason, allMessages, terminalOutcome } = await decideTurnOutcome({
    op,
    turnIdx,
    middlewareDirective,
    finalized,
    toolMessages,
    toolSummary,
    toolCalls,
    observedTools,
    assistantText,
    adapterTerminalReason: result.terminalReason ?? null,
    // The model's REAL stop signal (end_turn / stop), when the provider
    // carried it. decide-outcome trusts this to terminate even a non-silent
    // tool turn in one pass; absence → it falls back to shape inference.
    modelSignaledDone: result.modelStop === "ended",
    modelWantsToContinue: result.modelStop === "continue",
    adapterError,
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
    learnedOutcome: terminalOutcome ?? undefined,
    learningSessionId: learningSessionId ?? undefined,
    nextTurnPivot: middlewareDirective?.kind === "nudge" && middlewareDirective.metadata?.strategyPivot
      ? { message: middlewareDirective.message, metadata: { strategyPivot: middlewareDirective.metadata.strategyPivot } }
      : undefined,
  });

  // Tier 1.C: per-turn snapshot of any app files this turn wrote/edited.
  // Powers the IDE topbar's ↺ Revert dropdown so the user can undo a bad
  // edit without asking the agent to fix what it just broke.
  void snapshotTouchedApps(toolCalls, turnIdx);

  // Materialize nudges only after commit; pivot writes are replay-safe.
  if (middlewareDirective?.kind === "nudge") {
    if (middlewareDirective.metadata?.strategyPivot) {
      recoverCommittedStrategyPivot(op.id, turnIdx);
    } else {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, middlewareDirective.message, middlewareDirective.metadata);
    }
  }
  if (middlewareAborted) {
    emitErrorOnce(op.id, {
      code: "middleware-abort",
      message: middlewareDirective!.message ?? `Turn aborted by ${middlewareDirective!.firedBy}.`,
      retryable: false,
    });
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
