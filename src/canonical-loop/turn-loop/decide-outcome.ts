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
import { appIdsTouchedByTurn, registerOpAppTouch, runRenderVerifyGate, turnTouchedAppFiles } from "./render-verify.js";
import { runBuildVerifyGate, groundTruthSizesNote } from "./build-verify.js";
import { runSpecProbeGate } from "./spec-probes.js";
import { isRetractableHallucination, stripRetractedAssistant } from "./retract-false-claim.js";
import { openStepsTerminationWarning, earnedDoneNudge } from "../middlewares/open-steps.js";
import { opGaveUpUnrecovered } from "../middlewares/browser-handoff.js";
import { opCleanupUnverified } from "../middlewares/cleanup-verify.js";
import { opEditedSourceUnverified, opDeletedTestDodge, opEditedSourcePaths } from "../middlewares/verify-gate.js";
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
    // Let the phone-side ingress route this app's runtime errors to this op —
    // a phone-served page knows its appId, not a chat session id.
    for (const appId of appIdsTouchedByTurn(toolCalls)) registerOpAppTouch(op.id, appId);
    // appUrl lets the gate headlessly probe a build that no preview opened
    // (e.g. phone-triggered); task is the description for the screenshot judge.
    const gate = await runRenderVerifyGate(op.id, { appUrl: op.appUrl, appDescription: op.task });
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      terminalReason = null;
    }
    // gate.capReached → leave terminalReason="done" but the errors are
    // already drained; the user sees the broken preview + the model's
    // "done", same as today. Future: emit a one-line warning event.
  }

  // Build-verify gate (iteration 5). When the model says "done" on an op that
  // edited source but never reached a clean self-verify, the orchestrator runs
  // the project's OWN build/type-check itself and injects the REAL errors as the
  // next turn's user message — the model dodges the gentle "go verify" nudge, so
  // the environment verifies and hands back ground truth instead. The build
  // verdict is recorded into the verify-gate ledger, so a clean run lets "done"
  // stand AND records `clean`, while a red run loops (capped) and the label
  // stays `partial`. Mirrors render-verify: orchestrator gate, never a tool call.
  let buildVerifyConfirmation = "";
  if (terminalReason === "done" && opEditedSourceUnverified(op.id)) {
    const gate = await runBuildVerifyGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      terminalReason = null;
    } else if (gate.verifiedClean) {
      // The orchestrator ran the project's build itself and it PASSED, but the
      // model couldn't self-verify (blocked from running a build on source paths)
      // and may have wrapped up sounding unsure. Hold the green confirmation and
      // surface it below once we know the op truly ends this turn.
      buildVerifyConfirmation = gate.confirmation;
    }
  }

  // Spec-probe gate (iteration 6, the flagship). Build-green ≠ behaviorally
  // correct: the model can ship code that compiles yet does the wrong thing,
  // and its own self-tests miss it because it wrote them looking at the same
  // buggy implementation. So — only once the build gate above is satisfied
  // (terminalReason still "done") and the op edited source — the harness has the
  // SAME active model author an acceptance check while blind to the code (spec +
  // file names only), then EXECUTES it. A real spec-assertion failure injects one
  // capped retry nudge; a probe that can't validly run is discarded, never nudged,
  // so a correct implementation is never false-flagged. Nudge-only: unlike
  // build-verify it records no verdict, because the probe's authorship is fallible
  // and must never demote the outcome label.
  if (terminalReason === "done" && opEditedSourcePaths(op.id).length > 0) {
    const gate = await runSpecProbeGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      terminalReason = null;
    }
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

  // Reconcile-on-green: the orchestrator build-verify gate above ran the project's
  // build itself and it PASSED, but the model couldn't self-verify (blocked from
  // running a build on source paths) and may have wrapped up sounding unsure.
  // Surface the green verdict as the last word so the committed transcript matches
  // the outcome label (already recorded clean via recordOrchestratorVerify) — the
  // inverse of the loud-partial guarantee: a partial must never look done, and a
  // verified-clean edit must never look unverified. Only when the op truly ends
  // here and didn't also end partial.
  if (terminalReason !== null && !endedPartial && buildVerifyConfirmation) {
    publishStreamChunk(op.id, { text: `\n\n${buildVerifyConfirmation}` });
    allMessages.push({
      messageId: `build-verify-ok-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
      role: "assistant",
      content: { text: buildVerifyConfirmation },
    });
  }

  // Ground-truth file sizes: the claim-verify guards catch a lie about what a
  // TOOL did, but not a lie about what a FILE is. When the model's summary quotes
  // a line count (e.g. "AgentController.ts is 294 lines" when it's 588), state the
  // real sizes as the authoritative last word so a fabricated count can't stand.
  // Fires whether or not the model self-verified; silent when no size was quoted.
  if (terminalReason !== null && !endedPartial) {
    const sizesNote = groundTruthSizesNote(op.id, assistantText);
    if (sizesNote) {
      publishStreamChunk(op.id, { text: `\n\n${sizesNote}` });
      allMessages.push({
        messageId: `ground-truth-sizes-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
        role: "assistant",
        content: { text: sizesNote },
      });
    }
  }

  // Record the op outcome on its terminal turn (terminalReason stays non-null
  // only when every continuation gate above declined to extend it → fires once
  // per op).
  //
  // An op that ends still flagged give-up (browser-handoff computed the verdict;
  // the model was nudged but never delivered) is NOT clean — record it as partial
  // so the completion metric stops rounding give-ups up to success. Likewise a
  // removal/cleanup sweep that ends without a confirming empty search
  // (cleanup-verify's verdict), a coding op that edited source but never reached
  // a clean build/type-check (verify-gate's verdict), and an op the test-deletion
  // judge flagged as a DODGE (a live-code test deleted to go green): "done" over
  // an unverified edit or a dodged test is a partial, not a clean. All verdicts
  // default false for ops the gate never evaluated, so they only ever demote a
  // real unrecovered case.
  if (terminalReason !== null) {
    const outcome: OpOutcome =
      terminalReason === "error" ? "aborted"
        : endedPartial ? "partial"
        : opGaveUpUnrecovered(op.id) ? "partial"
        : opCleanupUnverified(op.id) ? "partial"
        : opEditedSourceUnverified(op.id) ? "partial"
        : opDeletedTestDodge(op.id) ? "partial"
        : "clean";
    recordTerminalOutcome(op, outcome, [...toolCalls.map(tc => tc.tool), ...observedTools]);
  }

  return { terminalReason, allMessages };
}

/**
 * Record the op's terminal outcome under its tool-derived category. The category
 * spans every tool the op touched across all committed turns (plus any extras
 * observed this turn), so an op that ends tool-lessly still classifies right.
 * Shared with the MAX_TURNS truncation path in worker.ts: a force-terminated op
 * transitions straight to failed, skipping this turn-loop, so without recording
 * here it would escape the outcome ledger entirely (the completion metric went
 * blind to every truncated run).
 */
export function recordTerminalOutcome(
  op: Op,
  outcome: OpOutcome,
  extraToolNames: Iterable<string> = [],
): void {
  const opToolNames = new Set<string>();
  for (const turn of readOpTurns(op.id)) {
    for (const s of turn.toolCallSummary ?? []) opToolNames.add(s.tool);
    for (const t of turn.observedTools ?? []) opToolNames.add(t);
  }
  for (const t of extraToolNames) opToolNames.add(t);
  recordOpOutcome(classifyOpCategory(opToolNames), outcome, resolveOpModel(op));
}
