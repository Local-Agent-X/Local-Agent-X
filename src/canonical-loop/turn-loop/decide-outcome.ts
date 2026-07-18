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
import { isRetractableHallucination, stripRetractedAssistant } from "./retract-false-claim.js";
import { applyTerminalEpilogue } from "./terminal-epilogue.js";
import { COMPLETION_GATES } from "./decide-outcome-gates.js";
import {
  CODEBASE_ADVICE_GROUNDING_REASON,
  CODEBASE_ADVICE_GROUNDING_STATUS,
} from "../../agent-guards/index.js";
import { createLogger } from "../../logger.js";
import { recordP1Outcome } from "./p1-metrics.js";
import { narrationPromisesFollowup } from "./p1-followup-detector.js";

const logger = createLogger("canonical-loop.turn-loop.decide-outcome");

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
  /**
   * The model's EXPLICIT continue signal: true when the provider reported a
   * tool_use / tool_calls end-of-turn (modelStop === "continue") — the model
   * paused FOR a tool result and wants another turn. Distinct from "no signal
   * on this path" (modelStop undefined), which still falls back to the shape
   * heuristics. When true, a committed mutation must NOT terminate the turn:
   * honoring tool_use is what stops a multi-step build from ending after every
   * single file write (the P-1 nudge-per-step failure, observed on BOTH grok
   * and Anthropic). See adapters/model-stop.ts.
   */
  modelWantsToContinue: boolean;
  adapterError: { code: string; message: string } | null;
}

export interface DecideOutcomeResult {
  terminalReason: "done" | "error" | null;
  allMessages: CommitTurnMessage[];
}

function replaceAssistantText(messages: CommitTurnMessage[], text: string): CommitTurnMessage[] {
  return messages.map(m => {
    if (m.role !== "assistant") return m;
    const content = m.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      return { ...m, content: { ...(content as Record<string, unknown>), text } };
    }
    return { ...m, content: { text } };
  });
}

/**
 * Decide the turn's terminal reason + assemble its commit-message list.
 * Async because the render-verify gate may await the preview iframe.
 */
export async function decideTurnOutcome(in_: DecideOutcomeInput): Promise<DecideOutcomeResult> {
  const {
    op, turnIdx, middlewareDirective,
    finalized, toolMessages, toolSummary, toolCalls, observedTools,
    assistantText, adapterTerminalReason, modelSignaledDone, modelWantsToContinue, adapterError,
  } = in_;

  // A confirmed-false-claim nudge (phantom worker, fake "I scheduled it")
  // means this terminal turn's assistant text is a lie. Retract it: clear the
  // live bubble and drop it from the committed transcript so the next turn's
  // correction is the only assistant message the user sees. See
  // turn-loop/retract-false-claim.ts.
  const retractFalseClaim =
    middlewareDirective?.kind === "nudge" &&
    isRetractableHallucination(middlewareDirective.reason);
  const replaceWithGroundingStatus =
    middlewareDirective?.kind === "nudge" &&
    middlewareDirective.reason === CODEBASE_ADVICE_GROUNDING_REASON;
  if (retractFalseClaim) {
    publishStreamChunk(op.id, { replace: true, text: "" });
  } else if (replaceWithGroundingStatus) {
    publishStreamChunk(op.id, { replace: true, text: CODEBASE_ADVICE_GROUNDING_STATUS });
  }

  let allMessages: CommitTurnMessage[] = [];
  for (const m of finalized) {
    allMessages.push({ messageId: m.messageId, role: m.role, content: m.content });
  }
  for (const tm of toolMessages) allMessages.push(tm);
  if (retractFalseClaim) allMessages = stripRetractedAssistant(allMessages);
  if (replaceWithGroundingStatus) {
    allMessages = replaceAssistantText(allMessages, CODEBASE_ADVICE_GROUNDING_STATUS);
  }

  // A middleware abort forces the turn to terminal=error so the worker
  // breaks the drive loop.
  const middlewareAborted = middlewareDirective?.kind === "abort";
  const middlewareSuspended = middlewareDirective?.kind === "suspend";
  let terminalReason: "done" | "error" | null = middlewareAborted
    ? "error"
    : middlewareSuspended
      ? null
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
  const hasSilentBrowser = allSilent && toolCalls.some(call => call.tool === "browser");
  const noTools = toolCalls.length === 0;
  const mutationCommitted = failureSummary.hadSuccessfulMutation;
  // Browser actions are only no-signal fallback terminators. `tool_use` /
  // `tool_calls` means the model wants their result, so ending here cuts off
  // multi-step work after navigate/click/scroll. Other silent tools are truly
  // fire-and-forget: voice_visual must not trigger duplicate speech, and
  // memory writes need no follow-up turn even if a weak provider says continue.
  const silentTerminates = allSilent && !(hasSilentBrowser && modelWantsToContinue);
  // P-1 FIX — honor the model's explicit continue signal. When the model
  // emitted a tool_use / tool_calls (modelWantsToContinue), it is asking for
  // another turn; a mutation that committed this turn must NOT terminate the op,
  // or a multi-step build ends after every single file write and the user has
  // to nudge it forward each step. This was the reported failure on BOTH grok
  // (finish_reason=tool_calls) and Anthropic (tool_use). A committed mutation
  // only stands in as a terminator when there is NO continue signal (modelStop
  // undefined) — the original "avoid a redundant post-mutation wrap-up" fallback
  // for adapter paths that surface no stop reason. When the model genuinely
  // ended, modelSignaledDone already terminates, so this never over-runs.
  const mutationTerminates = mutationCommitted && !modelWantsToContinue;
  // P-1 measurement (behavior-neutral). With the fix above, this now flags only
  // the residual fallback case: a committed mutation terminated the turn with NO
  // continue signal AND no other terminator. Kept as a regression watch (the
  // durable sink still splits it by whether a follow-up was promised).
  const mutationWasSoleDecider =
    terminalReason === null &&
    !middlewareAborted &&
    !middlewareSuspended &&
    assistantText.trim().length > 0 &&
    mutationTerminates && !modelSignaledDone && !allSilent && !noTools;
  if (
    terminalReason === null &&
    !middlewareAborted &&
    !middlewareSuspended &&
    (modelSignaledDone || silentTerminates || noTools || mutationTerminates) &&
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
  if (!middlewareAborted && !middlewareSuspended) {
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

  // Completion-gate chain. Once the turn is provisionally "done", walk the
  // single ordered gate table (COMPLETION_GATES in decide-outcome-gates.ts) —
  // render-verify → build-verify → spec-probe → design-verify → earned-done →
  // late-inject. Each gate runs ONLY while still "done" and may veto the
  // terminal by re-opening it (terminalReason → null), which drives one more
  // turn. This loop replaces a run of hand-inlined `if (terminalReason ===
  // "done") { … }` blocks with the same short-circuit and re-open semantics:
  // the chain stops the moment a gate re-opens, exactly as the per-block guard
  // did. See the per-gate docs in decide-outcome-gates.ts for each gate's own
  // entry condition, nudge, and cap. Build-verify is the only gate that also
  // holds a green confirmation (surfaced by the epilogue when the op truly
  // ends this turn).
  let buildVerifyConfirmation = "";
  for (const gate of COMPLETION_GATES) {
    if (terminalReason !== "done") break;
    const out = await gate.evaluate({ op, turnIdx, toolCalls });
    if (out.buildVerifyConfirmation !== undefined) buildVerifyConfirmation = out.buildVerifyConfirmation;
    if (out.reopen) terminalReason = null;
  }

  // P-1 measurement sink (behavior-neutral — nothing above or below reads this).
  // Emit only when the mutation shortcut was the sole reason this turn could
  // terminate, tagging the actual outcome: `terminated` = the op ended here and
  // a promised post-mutation follow-up (if any) was cut off; `reopened-by-gate`
  // = a completion gate (build-verify etc.) drove another turn anyway, so no
  // follow-up was lost. Grep `[p1-mutation-wrapup]` in the server log; the ratio
  // of terminated:reopened sizes the surgical fix before we ship it.
  if (mutationWasSoleDecider) {
    const outcome = terminalReason === "done" ? "terminated" : "reopened-by-gate";
    // Split the `terminated` count by whether the narration actually promised a
    // post-mutation step — that subset is the real harm the surgical fix would
    // recover. Only meaningful when we terminated (a gate re-open lost nothing).
    const promisedFollowup =
      outcome === "terminated" && narrationPromisesFollowup(assistantText);
    logger.info(
      `[p1-mutation-wrapup] op=${op.id} turn=${turnIdx} outcome=${outcome} promisedFollowup=${promisedFollowup}`,
    );
    // Durable aggregate (~/.lax/p1-metrics.json) — the log clears on restart.
    recordP1Outcome(outcome, promisedFollowup);
  }

  // Terminal epilogue (terminal-epilogue.ts): loud-partial warning,
  // reconcile-on-green confirmation, ground-truth sizes note, and the
  // clean/partial/aborted outcome record. Appends to allMessages in place.
  applyTerminalEpilogue(
    { op, turnIdx, terminalReason, assistantText, buildVerifyConfirmation, toolCalls, observedTools },
    allMessages,
  );

  return { terminalReason, allMessages };
}
