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
import { hasCapability } from "../../tool-registry.js";
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { isDispatchFailure } from "../types.js";

const NUDGE_AT = 3;
const ABORT_AT = 5;

interface RepeatFailureState {
  sig: string;
  family: string;
  count: number;
}

function createState(): RepeatFailureState {
  return { sig: "", family: "", count: 0 };
}

function toolFamily(toolName: string): string {
  return hasCapability(toolName, "shell") ? "shell" : toolName;
}

/** Tool name + normalized head of the error text. Args are deliberately NOT
 *  part of the signature — varying the payload against the same broken
 *  precondition is still the same failure. */
function failureSig(toolName: string, content: string): string {
  const family = toolFamily(toolName);
  if (family === "shell" && /BLOCKED \(unattended\)|layer=["']?sandbox/i.test(content)) {
    return "shell::unattended-sandbox";
  }
  return `${family}::${content.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

export const repeatFailureMiddleware: CanonicalMiddleware = {
  name: "repeat-failure",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<RepeatFailureState>(ctx.op.id, "repeat-failure", createState);
    for (const tr of ctx.toolResults) {
      if (!isDispatchFailure(tr.status)) {
        // Only success in the same tool family proves the agent escaped the
        // failure. Unrelated reads must not hide a shell loop.
        if (toolFamily(tr.toolName) === state.family && (tr.status === "ok" || tr.status === "cancelled")) {
          state.sig = "";
          state.family = "";
          state.count = 0;
        }
        continue;
      }
      const sig = failureSig(tr.toolName, tr.content);
      if (sig === state.sig) state.count++;
      else { state.sig = sig; state.family = toolFamily(tr.toolName); state.count = 1; }

      if (state.count >= ABORT_AT) {
        const message =
          `\n\n${isWorkerOp(ctx) ? "Suspended" : "Stopped"}: ${state.family} remained blocked after ${state.count} attempts. ` +
          `Last error: ${tr.content.slice(0, 200)}`;
        ctx.onEvent?.({ type: "stream", delta: message });
        state.sig = "";
        state.family = "";
        state.count = 0;
        return isWorkerOp(ctx)
          ? { kind: "suspend", reason: "repeat-failure", message }
          : { kind: "abort", reason: "repeat-failure", message };
      }
      if (state.count === NUDGE_AT) {
        return {
          kind: "nudge",
          reason: "repeat-failure",
          message:
            `${state.family} has hit the same unresolved failure ${NUDGE_AT} times:\n` +
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
