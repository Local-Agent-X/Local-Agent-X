/**
 * Post-dispatch outcome decision for one driveTurn (PRD §5 / §15).
 *
 * Given everything observed this turn — finalized messages, tool messages,
 * tool summary, tool calls, the assistant's user-facing text, the adapter's
 * terminal reason/error, and the sticky middleware directive — this computes
 * the turn's terminal reason and assembles the ordered commit-message list,
 * performing the retract / failure-nudge / continuation-guard / render-verify
 * side effects in the same order the orchestrator did inline.
 *
 * Pure structural lift out of the orchestrator: control flow, ordering, and
 * termination semantics are unchanged. Lives behind the ../turn-loop.ts
 * barrel like every other turn-loop helper.
 */
import type { CanonicalMessage, ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import { publishStreamChunk } from "../event-emitter.js";
import { hasInjects, opConsumesInjects } from "../../agent-loop/inject-queue.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import type { Op } from "../../ops/types.js";

import type { MiddlewareDirective } from "./types.js";
import { appendNudgeAsUserMessage } from "./nudges.js";
import {
  collectToolFailures,
  formatFailureNudgeForModel,
  shouldNudgeForFailures,
} from "./tool-failure-summary.js";
import { isSilentToolCall } from "./silent-tool-check.js";
import { runRenderVerifyGate, turnTouchedAppFiles } from "./render-verify.js";
import { isRetractableHallucination, stripRetractedAssistant } from "./retract-false-claim.js";
import { openStepsTerminationWarning, earnedDoneNudge } from "../middlewares/open-steps.js";
import { opGaveUpUnrecovered } from "../middlewares/browser-handoff.js";
import { readOpTurns } from "../store.js";
import { resolveOpModel } from "../op-model.js";
import { classifyOpCategory, recordOpOutcome, type OpOutcome } from "../../tool-tracker.js";
import { randomUUID } from "node:crypto";

export interface DecideOutcomeInput {
  op: Op;
  turnIdx: number;
  middlewareDirective: MiddlewareDirective | null;
  finalized: CanonicalMessage[];
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
  toolCalls: ToolCall[];
  /** Out-of-band (CLI/MCP) tool names observed THIS turn — folded into op categorization alongside prior turns' OpTurnRow.observedTools. */
  observedTools: string[];
  assistantText: string;
  adapterTerminalReason: "done" | "error" | null;
  /**
   * The model's REAL stop signal: true when the provider reported an
   * end-of-turn (Anthropic end_turn, OpenAI stop) for this turn. Distinct
   * from the shape heuristics below — when true we trust it directly. False
   * means either "model wants more" (tool_use) OR "no signal on this path",
   * both of which fall back to shape inference. Derived from
   * TurnResult.modelStop in turn-loop. See adapters/model-stop.ts.
   */
  modelSignaledDone: boolean;
  adapterError: { code: string; message: string } | null;
}

export interface DecideOutcomeResult {
  terminalReason: "done" | "error" | null;
  allMessages: CommitTurnMessage[];
}

/**
 * Decide the turn's terminal reason + assemble its commit-message list.
 * Async because the render-verify gate may await the preview iframe.
 */
export async function decideTurnOutcome(in_: DecideOutcomeInput): Promise<DecideOutcomeResult> {
  const {
    op, turnIdx, middlewareDirective,
    finalized, toolMessages, toolSummary, toolCalls, observedTools,
    assistantText, adapterTerminalReason, modelSignaledDone, adapterError,
  } = in_;

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

  // A middleware abort forces the turn to terminal=error so the worker
  // breaks the drive loop.
  const middlewareAborted = middlewareDirective?.kind === "abort";
  let terminalReason: "done" | "error" | null = middlewareAborted
    ? "error"
    : (adapterTerminalReason ?? (adapterError ? "error" : null));

  // Compute the failure summary up front — both the short-circuit below
  // and the gaslighting-nudge block below depend on whether at least one
  // mutation tool committed this turn.
  const failureSummary = collectToolFailures(toolMessages, toolSummary);

  // Turn-completion decision. terminalReason is still null here only for a
  // tool turn (the adapter returns terminalReason=undefined when tool calls
  // are outstanding and lets the loop decide whether to drive a wrap-up).
  //
  // PRIMARY signal — `modelSignaledDone`: the model's REAL stop_reason said
  // end_turn / stop. This is authoritative: the model declared the turn
  // finished, so feeding the tool result back for another pass would only
  // produce a redundant wrap-up paragraph. It's the genuine disambiguator the
  // shape heuristics can't see — a model that paused FOR a tool result emits
  // tool_use (→ modelSignaledDone=false), so trusting end_turn here can't drop
  // a result the model was waiting on. The tool still dispatched and committed
  // this turn (dispatch is independent of this decision); we just don't loop.
  //
  // FALLBACK — the shape heuristics, for paths/turns that DON'T surface a stop
  // reason (modelSignaledDone=false). Each is a proxy for "the model doesn't
  // need a wrap-up":
  //   - allSilent: every tool was visible-without-narration (memory writes,
  //     browser nav/clicks) — the activity row is the receipt.
  //   - noTools: a tool-less informational turn — nothing for a next turn to
  //     react to.
  //   - mutationCommitted: the model wrote/edited on disk AND narrated it — a
  //     wrap-up would just be a recovery monologue ("edit failed on whitespace,
  //     used write") the user already saw the result of.
  // Mixed non-silent turns with no stop signal (e.g. bash/web_fetch that
  // returns data) still drive a wrap-up so the data gets surfaced.
  //
  // All gated on non-empty assistant text: a turn that emitted only a tool
  // call (no narration) has nothing to terminate ON, and a prompt-inject CLI
  // turn that emits a JSON-only tool call ends with end_turn but empty text —
  // this guard keeps that case on the wrap-up path so its result feeds back.
  const allSilent = toolCalls.length > 0 && toolCalls.every(isSilentToolCall);
  const noTools = toolCalls.length === 0;
  const mutationCommitted = failureSummary.hadSuccessfulMutation;
  if (
    terminalReason === null &&
    !middlewareAborted &&
    (modelSignaledDone || allSilent || noTools || mutationCommitted) &&
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

  // Earned-"done" gate (unattended lanes only). Before accepting a worker /
  // background / build op's "done" while its own task list still has open
  // steps, force ONE more turn pointed at "finish or justify stopping". This is
  // the model-agnostic equalizer for runs nobody is watching: a weak model that
  // hands over a partial and waits for "continue" gets that push exactly once.
  // Interactive chat is excluded (earnedDoneNudge returns null) — never loop a
  // turn out from under the user. Bounded to one fire per op, so the second
  // pass falls through to the loud-partial warning below.
  if (terminalReason === "done") {
    const nudge = earnedDoneNudge(op);
    if (nudge) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, nudge);
      terminalReason = null;
    }
  }

  // Loud-partial guarantee: when the op truly ends here (every continuation
  // gate above declined to extend it) but this op's own task list still has
  // open steps, append a visible warning to the live bubble AND the committed
  // transcript. We can't force a stuck model to finish — the open-steps
  // middleware and the earned-done gate already spent their nudges — but a
  // partial must never LOOK like a finished answer, in chat or in a mission
  // report.
  let endedPartial = false;
  if (terminalReason === "done") {
    const warning = openStepsTerminationWarning(op.id);
    if (warning) {
      endedPartial = true;
      publishStreamChunk(op.id, { text: `\n\n${warning}` });
      allMessages.push({
        messageId: `open-steps-warn-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
        role: "assistant",
        content: { text: warning },
      });
    }
  }

  // Record the op outcome on its terminal turn (terminalReason stays non-null
  // only when every continuation gate above declined to extend it → fires once
  // per op). Category comes from every tool the op touched, not just this turn,
  // so a browser run that ends on a tool-less wrap-up still counts as "browser".
  if (terminalReason !== null) {
    const opToolNames = new Set<string>();
    for (const turn of readOpTurns(op.id)) {
      for (const s of turn.toolCallSummary ?? []) opToolNames.add(s.tool);
      for (const t of turn.observedTools ?? []) opToolNames.add(t);
    }
    for (const tc of toolCalls) opToolNames.add(tc.tool);
    for (const t of observedTools) opToolNames.add(t);
    // An op that ends still flagged give-up (browser-handoff computed the
    // verdict; the model was nudged but never delivered) is NOT clean — record
    // it as partial so the completion metric stops rounding give-ups up to
    // success. The verdict defaults false for ops the gate never evaluated, so
    // this only ever demotes a real unrecovered give-up.
    const outcome: OpOutcome =
      terminalReason === "error" ? "aborted"
        : endedPartial ? "partial"
        : opGaveUpUnrecovered(op.id) ? "partial"
        : "clean";
    recordOpOutcome(classifyOpCategory(opToolNames), outcome, resolveOpModel(op));
  }

  return { terminalReason, allMessages };
}
