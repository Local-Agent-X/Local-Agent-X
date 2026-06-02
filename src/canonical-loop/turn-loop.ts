/**
 * turn_loop — the inner per-turn driver (PRD §5 / §15).
 *
 * One driveTurn call assembles input from history, hands it to the adapter,
 * forwards stream chunks to the bus, captures finalized messages and
 * tool_call_requested adapter_reports, dispatches tool calls via the
 * canonical tool-dispatcher boundary, then hands all of it to commitTurn
 * for the atomic post-turn write.
 *
 * Boundary rules:
 *   - The loop never executes tools itself — every tool round-trip goes
 *     through `getToolDispatcher().dispatch(call)`.
 *   - The loop never writes `op_events` directly — every event goes through
 *     `emit()`.
 *   - The adapter never writes anything; it only emits adapter_report items
 *     through the report callback.
 *
 * Helpers split into ./turn-loop/* — this file is the orchestrator.
 */
import type { Adapter, AdapterReport } from "./adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "./contract-types.js";
import type { ProviderStateEnvelope } from "./types.js";
import { emit, emitErrorOnce, publishStreamChunk } from "./event-emitter.js";
import { commitTurn, type CommitTurnMessage } from "./checkpoint.js";
import { getToolsForOp } from "./runtime.js";
import type { Op } from "../ops/types.js";
import {
  buildCanonicalLoopContext,
  getActiveMiddlewareStack,
  runMiddlewarePhase,
} from "./middlewares/host.js";
import type { CanonicalToolResultView } from "./middlewares/types.js";
import { getEvidenceHistory } from "./middlewares/evidence-history.js";

import type { DriveTurnResult, DriveTurnOptions, MiddlewareDirective } from "./turn-loop/types.js";
import { extractText, extractToolResultText } from "./turn-loop/content-extract.js";
import { appendNudgeAsUserMessage, middlewareAbortResult } from "./turn-loop/nudges.js";
import { buildTurnInput, readPendingRedirect } from "./turn-loop/build-input.js";
import { drainInjectsIntoTurn } from "./turn-loop/inject-drain.js";
import {
  collectToolFailures,
  formatFailureNudgeForModel,
  shouldNudgeForFailures,
} from "./turn-loop/tool-failure-summary.js";
import { hasInjects } from "../agent-loop/inject-queue.js";
import { getSessionForOp } from "../ops/session-bridge.js";
import { dispatchTools } from "./turn-loop/dispatch-tools.js";
import { createIdleWatchdog, readIdleTimeoutMs } from "./turn-loop/idle-watchdog.js";
import { isSilentToolCall } from "./turn-loop/silent-tool-check.js";
import { snapshotTouchedApps } from "./turn-loop/snapshot-apps.js";
import { runRenderVerifyGate, turnTouchedAppFiles } from "./turn-loop/render-verify.js";
import { isRetractableHallucination, stripRetractedAssistant } from "./turn-loop/retract-false-claim.js";

export type { DriveTurnResult, DriveTurnOptions } from "./turn-loop/types.js";

export async function driveTurn(
  op: Op,
  adapter: Adapter,
  turnIdx: number,
  opts: DriveTurnOptions = {},
): Promise<DriveTurnResult> {
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
  // turn. Mirrors agent-loop's interjectDrainMiddleware. Scoped to chat_turn
  // so background/delegated workers sharing the session don't drain the
  // user's chat-bound injects.
  if (op.type === "chat_turn") drainInjectsIntoTurn(op, turnIdx);

  // ── Phase 1: beforeTurn middlewares ──
  // Snapshot a fresh CanonicalLoopContext from disk + op state. A `nudge`
  // here appends a synthetic user message at the CURRENT turnIdx so this
  // turn's adapter sees it (mirrors agent-loop's beforeIteration→push-then-
  // restart-iteration). An `abort` short-circuits the whole turn — no
  // adapter call, no tool dispatch — and the worker exits.
  const evidenceHistory = getEvidenceHistory(op.id);
  const middlewareStack = getActiveMiddlewareStack();
  const beforeCtx = buildCanonicalLoopContext({
    op, turnIdx,
    tools: getToolsForOp(op.id),
    evidenceHistory,
  });
  const beforeRes = await runMiddlewarePhase(beforeCtx, "beforeTurn", middlewareStack);
  if (beforeRes.kind === "abort") {
    return middlewareAbortResult(op, turnIdx, beforeRes);
  }
  if (beforeRes.kind === "nudge") {
    appendNudgeAsUserMessage(op.id, turnIdx, beforeRes.message);
    // Fall through — next read of op_messages (buildTurnInput, below) picks
    // the nudge up and ships it to the adapter on this turn.
  }

  const input = buildTurnInput(op, turnIdx, pendingRedirect);

  const finalized: CanonicalMessage[] = [];
  const toolCalls: ToolCall[] = [];
  let adapterError: { code: string; message: string } | null = null;
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
      adapterError = { code: "stalled", message: `no adapter reports for ${idleMs}ms — model presumed stuck` };
      emit(op.id, "error", { code: "stalled", message: adapterError.message, retryable: false });
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
  const result = await adapter.runTurn(input, (r: AdapterReport) => {
    watchdog.noteActivity();
    if (r.kind === "stream_chunk") {
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
    if (r.kind === "error") {
      adapterError = { code: r.code, message: r.message };
      emit(op.id, "error", { code: r.code, message: r.message, retryable: r.retryable });
    }
  });
  watchdog.disarm();
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
  const afterModelCtx = buildCanonicalLoopContext({
    op, turnIdx,
    tools: getToolsForOp(op.id),
    toolCalls,
    assistantContent: assistantText,
    evidenceHistory,
  });
  // Wire the live toolCalls array so auto-build-app's push mutates the
  // dispatcher's input. buildCanonicalLoopContext already passes it; this
  // is documentation for the next reader.
  afterModelCtx.toolCalls = toolCalls;
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
    };
  }

  const toolDispatchStart = Date.now();
  // If a middleware aborted, skip tool dispatch — same effect as agent-
  // loop's runPhase short-circuit before tool execution.
  const { toolMessages, toolSummary } = middlewareDirective?.kind === "abort"
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
    const toolResultsView: CanonicalToolResultView[] = toolMessages.map((tm, i) => ({
      toolName: toolSummary[i]?.tool ?? "unknown",
      toolCallId: (tm.content as { toolCallId?: string })?.toolCallId ?? "",
      content: extractToolResultText(tm.content),
    }));
    const afterToolCtx = buildCanonicalLoopContext({
      op, turnIdx,
      tools: getToolsForOp(op.id),
      toolCalls,
      toolResults: toolResultsView,
      assistantContent: assistantText,
      evidenceHistory,
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
      };
    }
  }

  // A confirmed-false-claim nudge (phantom worker, fake "I scheduled it")
  // means this terminal turn's assistant text is a lie. Retract it: clear the
  // live bubble and drop it from the committed transcript so the next turn's
  // correction is the only assistant message the user sees. See
  // turn-loop/retract-false-claim.ts.
  const retractFalseClaim =
    middlewareDirective?.kind === "nudge" &&
    isRetractableHallucination(middlewareDirective.reason);
  if (retractFalseClaim) {
    publishStreamChunk(op.id, { replace: true, text: "" });
  }

  let allMessages: CommitTurnMessage[] = [];
  for (const m of finalized) {
    allMessages.push({ messageId: m.messageId, role: m.role, content: m.content });
  }
  for (const tm of toolMessages) allMessages.push(tm);
  if (retractFalseClaim) allMessages = stripRetractedAssistant(allMessages);

  const providerState: ProviderStateEnvelope = result.providerState;
  // A middleware abort forces the turn to terminal=error so the worker
  // breaks the drive loop.
  const middlewareAborted = middlewareDirective?.kind === "abort";
  let terminalReason: "done" | "error" | null = middlewareAborted
    ? "error"
    : (result.terminalReason ?? (adapterError ? "error" : null));

  // Compute the failure summary up front — both the short-circuit below
  // and the gaslighting-nudge block below depend on whether at least one
  // mutation tool committed this turn.
  const failureSummary = collectToolFailures(toolMessages, toolSummary);

  // Silent-side-effect short-circuit. When every tool call this turn is
  // visible-without-narration (memory writes, browser navigation/clicks)
  // AND the model already produced user-facing text, terminate the turn
  // so the worker doesn't drive a wrap-up "no blocker, done" pass. The
  // activity row is the receipt. Mixed turns (silent + bash/web_fetch)
  // still drive a wrap-up so data-returning results get surfaced. See
  // turn-loop/silent-tool-check.ts for the predicate.
  //
  // Same reasoning extends to tool-less informational turns: if the model
  // answered with text and made zero tool calls, there is nothing for a
  // next turn to react to. Without this branch, when the adapter doesn't
  // surface a stop signal (Anthropic CLI subscription path doesn't carry
  // end_turn through), the worker loops and the model produces a
  // "no blocker / informational / nothing to commit" paragraph that reads
  // as internal scratchwork to the user.
  //
  // And same for mutation-committed turns: if the model wrote/edited
  // something on disk (or otherwise committed a mutation tool) AND
  // produced user-facing text, the turn is done. Without this, a turn
  // that retried `edit` a few times before succeeding with `write`
  // surfaces a second wrap-up turn whose entire payload is the model
  // narrating "Previous edits failed on whitespace, used full write
  // instead" — the user already saw the success summary in turn N and
  // does not need turn N+1's recovery monologue.
  const allSilent = toolCalls.length > 0 && toolCalls.every(isSilentToolCall);
  const noTools = toolCalls.length === 0;
  const mutationCommitted = failureSummary.hadSuccessfulMutation;
  if (
    terminalReason === null &&
    !middlewareAborted &&
    (allSilent || noTools || mutationCommitted) &&
    assistantText.trim().length > 0
  ) {
    terminalReason = "done";
  }

  // Active gaslighting-prevention: when tools returned non-ok statuses
  // this turn AND no successful mutation landed, inject a nudge into
  // turn+1 telling the model to acknowledge or fix. Mixed turns
  // (failures + at least one successful mutation) are NOT gaslighting —
  // the model iterated and ultimately changed something on disk. The
  // existing per-op turn cap bounds the retry.
  let failureNudged = false;
  if (!middlewareAborted) {
    if (shouldNudgeForFailures(failureSummary)) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, formatFailureNudgeForModel(failureSummary));
      failureNudged = true;
    }
  }

  // Unified continuation guard. Whenever the worker is going to keep
  // looping past this turn (middleware nudge appended at turn+1, our
  // own failure-detection nudge above, or a mid-turn user inject sitting
  // in the chat queue), we MUST NOT call transitionOp(succeeded) inside
  // commitTurn — the next turn will also resolve as done and the second
  // succeeded → succeeded transition is illegal and surfaces as a
  // worker_exception in chat. Bug screenshot 2026-05-23: a game-loop
  // fix landed but the user saw a confusing red error.
  //
  // The worker's resume-gate logic mirrors these three conditions; this
  // is the corresponding pre-commit gate so commitTurn doesn't end the
  // op while the worker is still planning to spin another turn.
  if (terminalReason === "done") {
    const middlewareNudged = middlewareDirective?.kind === "nudge";
    // Only chat_turn ops drain injects into their next turn (see
    // line 76 above and inject-drain.ts:5). A freeform / delegated op
    // sharing a session with pending chat injects must NOT extend itself
    // waiting for them — the injects belong to the chat_turn worker.
    // Without this gate, "non-chat_turn ops do NOT drain the queue" was
    // accidentally upgraded to "non-chat_turn ops hang forever whenever a
    // chat inject is queued on the same session."
    const sessionId = getSessionForOp(op.id);
    const injectsPending = op.type === "chat_turn" && sessionId ? hasInjects(sessionId) : false;
    if (middlewareNudged || failureNudged || injectsPending) {
      terminalReason = null;
    }
  }

  // Render-verify gate (Tier 1.A). When the model says "done" on a turn
  // that wrote/edited files under workspace/apps/<id>/, give the preview
  // iframe a moment to report any uncaught errors / unhandled rejections
  // / console.errors that landed after the reload. If errors arrive
  // within the window, suppress the terminal, prepend a formatted error
  // block as a synthetic user message on the next turn, and let the same
  // model fix what it just broke. Capped at MAX_RETRIES so an unfixable
  // bug can't infinite-loop.
  if (terminalReason === "done" && turnTouchedAppFiles(toolCalls)) {
    const gate = await runRenderVerifyGate(op.id);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      terminalReason = null;
    }
    // gate.capReached → leave terminalReason="done" but the errors are
    // already drained; the user sees the broken preview + the model's
    // "done", same as today. Future: emit a one-line warning event.
  }

  commitTurn({
    op,
    turnIdx,
    providerState,
    messages: allMessages,
    toolCallSummary: toolSummary,
    terminalReason,
    redirectConsumed: pendingRedirect != null,
    redirectInstructionId: pendingRedirect?.instructionId,
    modelMs,
    toolDispatchMs,
  });

  // Tier 1.C: per-turn snapshot of any app files this turn wrote/edited.
  // Powers the IDE topbar's ↺ Revert dropdown so the user can undo a bad
  // edit without asking the agent to fix what it just broke.
  void snapshotTouchedApps(toolCalls, turnIdx);

  // For nudges, append the synthetic user message at turnIdx+1 so the next
  // driveTurn sees it via buildTurnInput's op_messages read. For aborts,
  // emit a stopped event so chat UI surfaces a one-line reason instead of a
  // frozen cursor. Mirrors agent-loop/run.ts:surfaceMiddlewareAbort.
  if (middlewareDirective?.kind === "nudge") {
    appendNudgeAsUserMessage(op.id, turnIdx + 1, middlewareDirective.message);
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
          message: middlewareDirective.kind === "nudge"
            ? middlewareDirective.message
            : middlewareDirective.message,
        }
      : undefined,
  };
}
