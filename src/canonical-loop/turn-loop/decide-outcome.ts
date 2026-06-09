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
import { hasInjects } from "../../agent-loop/inject-queue.js";
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

export interface DecideOutcomeInput {
  op: Op;
  turnIdx: number;
  middlewareDirective: MiddlewareDirective | null;
  finalized: CanonicalMessage[];
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
  toolCalls: ToolCall[];
  assistantText: string;
  adapterTerminalReason: "done" | "error" | null;
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
    finalized, toolMessages, toolSummary, toolCalls,
    assistantText, adapterTerminalReason, adapterError,
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
    // turn-loop.ts drainInjectsIntoTurn and inject-drain.ts:5). A freeform /
    // delegated op sharing a session with pending chat injects must NOT
    // extend itself waiting for them — the injects belong to the chat_turn
    // worker. Without this gate, "non-chat_turn ops do NOT drain the queue"
    // was accidentally upgraded to "non-chat_turn ops hang forever whenever a
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

  return { terminalReason, allMessages };
}
