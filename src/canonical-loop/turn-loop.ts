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
import type { Adapter, AdapterReport, TurnResult } from "./adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "./contract-types.js";
import type { ProviderStateEnvelope } from "./types.js";
import { emit, emitErrorOnce, publishStreamChunk } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
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
import { opConsumesInjects } from "../agent-loop/inject-queue.js";
import { dispatchTools } from "./turn-loop/dispatch-tools.js";
import { createIdleWatchdog, readIdleTimeoutMs } from "./turn-loop/idle-watchdog.js";
import { snapshotTouchedApps } from "./turn-loop/snapshot-apps.js";
import { decideTurnOutcome } from "./turn-loop/decide-outcome.js";

export type { DriveTurnResult, DriveTurnOptions } from "./turn-loop/types.js";

// Consecutive THROWN adapter errors per op — provider hangs/timeouts the
// adapter couldn't convert into a kind:"error" report. Bounds the feed-back-
// and-continue recovery (below) so a hard-down provider gives up after a few
// stalls instead of spinning the op's whole wall-clock budget (2h on a chat
// turn). In-memory by design: a worker crash/recovery resets the count, and
// op recovery has its own bound (heartbeat.ts retryPolicy). Cleared on any
// successful model call and when the cap is hit.
const adapterThrowStreaks = new Map<string, number>();
const ADAPTER_ERROR_CAP = 2;

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

  const input = await buildTurnInput(op, turnIdx, pendingRedirect);

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
  let result: TurnResult;
  try {
    result = await adapter.runTurn(input, (r: AdapterReport) => {
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
  } catch (e) {
    // A THROWN adapter error (a provider HTTP/stream timeout the adapter did
    // NOT convert into a kind:"error" report — e.g. "xai call threw: The
    // operation was aborted due to timeout") must NOT escape driveTurn:
    // escaping skips the terminal path below, so the op never finalizes and
    // the chat "thinking…" spinner hangs forever (live failure 2026-06-19,
    // Grok stall).
    //
    // Recover the way TOOL failures already do (turn-loop/tool-failure-
    // summary.ts): feed the error back to the model as a synthetic user nudge
    // and CONTINUE the loop (terminalReason=null) so it resumes from committed
    // state on the next turn. Bounded by ADAPTER_ERROR_CAP — a hard-down
    // provider would otherwise spin the whole wall-clock budget. After the cap,
    // fall through to a terminal "error" (the floor) so the op finalizes and
    // the spinner clears with a visible reason.
    watchdog.disarm();
    const message = e instanceof Error ? e.message : String(e);
    const streak = (adapterThrowStreaks.get(op.id) ?? 0) + 1;
    if (streak <= ADAPTER_ERROR_CAP) {
      adapterThrowStreaks.set(op.id, streak);
      emit(op.id, "error", { code: "adapter_retry", message: `${message} — retrying (${streak}/${ADAPTER_ERROR_CAP})`, retryable: true });
      appendNudgeAsUserMessage(
        op.id,
        turnIdx + 1,
        `Your previous step did not complete — it hit a transient provider error: ${message}. This is not a mistake on your part. Resume exactly where you left off and finish the task; do not restart from scratch.`,
      );
      return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: false };
    }
    adapterThrowStreaks.delete(op.id);
    emit(op.id, "error", { code: "adapter_error_exhausted", message: `The model provider failed ${ADAPTER_ERROR_CAP + 1} times in a row (last: ${message}). Stopping — retry, or switch to a more reliable model.`, retryable: false });
    // commitTurn (the normal terminal path) is what transitions running →
    // failed, and this early return skips it — so fail the op explicitly here,
    // or it would stay "running" and re-create the very hang this fixes.
    transitionOp(op, "failed", "adapter_error_exhausted");
    return { terminalReason: "error", toolCount: 0, messageCount: 0, cancelled: false };
  }
  watchdog.disarm();
  // A model call that actually returned (success, or a reported kind:"error")
  // breaks the THROWN-error streak — the provider is responding again.
  adapterThrowStreaks.delete(op.id);
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
      status: toolSummary[i]?.resultStatus,
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

  const providerState: ProviderStateEnvelope = result.providerState;
  const middlewareAborted = middlewareDirective?.kind === "abort";

  // Decide terminal reason + assemble the commit-message list, running the
  // retract / failure-nudge / continuation-guard / render-verify side
  // effects. See turn-loop/decide-outcome.ts.
  const { terminalReason, allMessages } = await decideTurnOutcome({
    op,
    turnIdx,
    middlewareDirective,
    finalized,
    toolMessages,
    toolSummary,
    toolCalls,
    assistantText,
    adapterTerminalReason: result.terminalReason ?? null,
    // The model's REAL stop signal (end_turn / stop), when the provider
    // carried it. decide-outcome trusts this to terminate even a non-silent
    // tool turn in one pass; absence → it falls back to shape inference.
    modelSignaledDone: result.modelStop === "ended",
    adapterError,
  });

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
