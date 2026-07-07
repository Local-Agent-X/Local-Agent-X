/**
 * Repeat-failure breaker — the same tool failing with the same error over
 * and over is the clearest stuck signal there is, and none of the other
 * guards caught it:
 *
 *   - exact-repeat (loop-detection) needs IDENTICAL args; a flailing model
 *     varies its payload while the error stays the same.
 *   - loop-detection/dead-end are worker-only; the 2026-06-10 runaway was an
 *     interactive chat turn: 19 consecutive presentation_edit errors against
 *     a file the model had just deleted, every ~2.5s until the turn died.
 *
 * Runs on ALL lanes (no `when`) because a failure spiral is equally wrong in
 * chat and voice — and the nudge/abort text is phrased for any audience.
 * Keys on the dispatcher's real resultStatus, not error-shaped text.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { isDispatchFailure } from "../types.js";

const NUDGE_AT = 3;
const ABORT_AT = 5;

interface RepeatFailureState {
  sig: string;
  count: number;
}

function createState(): RepeatFailureState {
  return { sig: "", count: 0 };
}

/** Tool name + normalized head of the error text. Args are deliberately NOT
 *  part of the signature — varying the payload against the same broken
 *  precondition is still the same failure. */
function failureSig(toolName: string, content: string): string {
  return `${toolName}::${content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

export const repeatFailureMiddleware: CanonicalMiddleware = {
  name: "repeat-failure",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<RepeatFailureState>(ctx.op.id, "repeat-failure", createState);
    for (const tr of ctx.toolResults) {
      if (!isDispatchFailure(tr.status)) {
        // Any success breaks the streak — the model changed something real.
        // Failure = error|blocked|declined|timeout (all of these arrived as
        // "error" before the boundary carried the envelope flavor, and a
        // model re-slamming a blocked/declined/timed-out call is exactly as
        // stuck). The signature keys on tool+content, so a blocked-then-
        // timeout sequence still counts as DIFFERENT failures — dedup
        // behavior is unchanged by the widening.
        state.sig = "";
        state.count = 0;
        continue;
      }
      const sig = failureSig(tr.toolName, tr.content);
      if (sig === state.sig) state.count++;
      else { state.sig = sig; state.count = 1; }

      if (state.count >= ABORT_AT) {
        const message =
          `\n\nStopped: ${tr.toolName} failed ${state.count} times in a row with the same error. ` +
          `Last error: ${tr.content.slice(0, 200)}`;
        ctx.onEvent?.({ type: "stream", delta: message });
        state.sig = "";
        state.count = 0;
        return { kind: "abort", reason: "repeat-failure", message };
      }
      if (state.count === NUDGE_AT) {
        return {
          kind: "nudge",
          reason: "repeat-failure",
          message:
            `${tr.toolName} has failed ${NUDGE_AT} times in a row with the same error:\n` +
            `${tr.content.slice(0, 300)}\n\n` +
            "Repeating this call will not change the outcome. Fix the underlying cause first " +
            "(if the file no longer exists, create it with the appropriate create tool), switch " +
            "to a different tool, or tell the user exactly what is blocking you.",
        };
      }
    }
    return { kind: "continue" };
  },
};
