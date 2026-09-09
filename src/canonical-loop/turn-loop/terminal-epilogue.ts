/**
 * Terminal-turn epilogue — the last words appended once decide-outcome has
 * settled that the op truly ends this turn (every continuation gate declined
 * to extend it), plus the outcome-label record. Split out of decide-outcome.ts
 * (source-hygiene LOC ceiling); pure structural lift, ordering unchanged:
 *
 *   1. Loud-partial guarantee — open steps remain → visible warning.
 *   2. Reconcile-on-green — orchestrator build passed → green confirmation.
 *   3. Ground-truth file sizes — quoted line counts corrected.
 *   4. recordTerminalOutcome — clean / partial / aborted label.
 */
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { Op } from "../../ops/types.js";
import { publishStreamChunk } from "../event-emitter.js";
import { openStepsTerminationWarning } from "../middlewares/open-steps.js";
import { opGaveUpUnrecovered } from "../middlewares/browser-handoff.js";
import { opCleanupUnverified } from "../middlewares/cleanup-verify.js";
import { opEditedSourceUnverified, opDeletedTestDodge } from "../middlewares/verify-gate.js";
import { groundTruthSizesNote } from "./build-verify.js";
import { gateSource } from "./decide-outcome-gate-contract.js";
import type { GuardFire } from "./guard-fire.js";
import { recordTerminalOutcome, type OpOutcome } from "./record-outcome.js";

export interface TerminalEpilogueInput {
  op: Op;
  turnIdx: number;
  terminalReason: "done" | "error" | null;
  assistantText: string;
  /** Held green confirmation from the orchestrator build-verify gate ("" = none). */
  buildVerifyConfirmation: string;
  toolCalls: ToolCall[];
  observedTools: string[];
}

/** Append the epilogue notes to the live bubble + `allMessages` (mutated in
 *  place) and record the op outcome. No-op on non-terminal turns.
 *
 *  `earnedFires` is the same mutated-in-place contract as `allMessages`, and
 *  for the same reason: what this function appends is a fire's evidence, so the
 *  fire has to be contributed exactly where the append is decided. It is
 *  REQUIRED rather than optional — an optional collector is one a future caller
 *  can forget, and a forgotten one is silently uncounted, which is the whole
 *  failure the fire ledger exists to end. */
export function applyTerminalEpilogue(
  in_: TerminalEpilogueInput,
  allMessages: CommitTurnMessage[],
  earnedFires: GuardFire[],
): OpOutcome | null {
  const { op, turnIdx, terminalReason, assistantText, buildVerifyConfirmation, toolCalls, observedTools } = in_;

  // Loud-partial guarantee: when the op truly ends here but its task list still
  // has open steps, append a visible warning to the live bubble AND the commit.
  // We can't force a stuck model to finish — open-steps and earned-done already
  // spent their nudges — but a partial must never LOOK finished. This and the
  // two live corrections below publish `delta` (append), NOT `text`: every
  // subscribeOpStream consumer forwards a chunk only on a non-empty `delta` or
  // `replace:true`, so a bare `{text}` is dropped and surfaces only on rehydrate.
  let endedPartial = false;
  if (terminalReason === "done") {
    const warning = openStepsTerminationWarning(op.id);
    if (warning) {
      endedPartial = true;
      publishStreamChunk(op.id, { delta: `\n\n${warning}` });
      allMessages.push({
        messageId: `open-steps-warn-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
        role: "assistant",
        content: { text: warning },
      });
    }
  }

  // Reconcile-on-green: the orchestrator build-verify gate ran the project's
  // build itself and it PASSED, but the model couldn't self-verify (blocked from
  // running a build on source paths) and may have wrapped up sounding unsure.
  // Surface the green verdict as the last word so the committed transcript matches
  // the outcome label (already recorded clean via recordOrchestratorVerify) — the
  // inverse of the loud-partial guarantee: a partial must never look done, and a
  // verified-clean edit must never look unverified. Only when the op truly ends
  // here and didn't also end partial.
  if (terminalReason !== null && !endedPartial && buildVerifyConfirmation) {
    publishStreamChunk(op.id, { delta: `\n\n${buildVerifyConfirmation}` });
    allMessages.push({
      messageId: `build-verify-ok-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
      role: "assistant",
      content: { text: buildVerifyConfirmation },
    });
    // The fire for build-verify's held confirmation, contributed INSIDE the
    // `if` that decides the append and nowhere earlier. The gate settled
    // `verifiedClean` turns ago; whether the user ever sees the green line is
    // settled HERE, by `!endedPartial` — an op that ends partial suppresses the
    // message, so a fire banked at the gate would count a terminal nobody was
    // shown. Sharing the condition is what makes that impossible.
    //
    // `honest-terminal` and NOT a new shape: this is a completion gate letting
    // the turn end while authoring its closing words — the definition already
    // in the vocabulary, in the same `allMessages` push, in the same
    // user-facing shape as the gate terminal beside it. A second value for the
    // second producer of one act would make the discriminator a call-site list.
    // The cost is that `honest-terminal` is now a census of TWO producers, not
    // one; slice by `name` for a single gate (guard-fire.ts states this).
    earnedFires.push(gateSource("build-verify", "honest-terminal"));
  }

  // Ground-truth file sizes: the claim-verify guards catch a lie about what a
  // TOOL did, but not a lie about what a FILE is. When the model's summary quotes
  // a line count (e.g. "AgentController.ts is 294 lines" when it's 588), state the
  // real sizes as the authoritative last word so a fabricated count can't stand.
  // Fires whether or not the model self-verified; silent when no size was quoted.
  if (terminalReason !== null && !endedPartial) {
    const sizesNote = groundTruthSizesNote(op.id, assistantText, op.sessionId);
    if (sizesNote) {
      publishStreamChunk(op.id, { delta: `\n\n${sizesNote}` });
      allMessages.push({
        messageId: `ground-truth-sizes-${op.id}-${turnIdx}-${randomUUID().slice(0, 6)}`,
        role: "assistant",
        content: { text: sizesNote },
      });
    }
  }

  // Record the op outcome on its terminal turn (terminalReason stays non-null
  // only when every continuation gate in decide-outcome declined to extend it
  // → fires once per op).
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
    return outcome;
  }
  return null;
}
