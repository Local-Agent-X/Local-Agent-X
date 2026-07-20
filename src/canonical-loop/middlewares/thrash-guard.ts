/**
 * Thrash guard — catches the agent routing around failures by flipping
 * settings instead of stopping to report the blocker.
 *
 * The 2026-07-20 incident this closes: a 9.7-minute interactive turn where
 * the agent cycled browserMode in-app → isolated → advanced-shared → in-app
 * (plus an enableComputerControl flip) between failing browser calls, with
 * zero task progress. Every existing guard was structurally blind to it:
 *
 *   - circuit-breaker keys per (session, tool, ARGS-SIG) — varied args means
 *     each failure starts a fresh bucket at #1.
 *   - repeat-failure keys per (family, ERROR-HEAD) — varied errors reset it.
 *   - loop-detection's no-progress counter treats `browser` as a mutation
 *     override, so every FAILED browser attempt reset the counter; `setting`
 *     isn't in the risk taxonomy at all.
 *
 * None of them correlate "protected setting flipped → same failures keep
 * coming". This middleware counts exactly that CYCLE: a protected-field
 * `setting` flip that lands after ≥1 dispatch failure (a REACTIVE flip),
 * followed by another dispatch failure. Two cycles → nudge (stop flipping,
 * quote the blocker, ask the user); four → abort/suspend, mirroring
 * repeat-failure's two-stage shape.
 *
 * User-requested single flips don't trip it: one flip is never ≥2 cycles,
 * and a flip with no prior failure in the op isn't reactive at all.
 */
import { isProtectedSetting } from "../../settings-schema.js";
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { isDispatchFailure } from "../types.js";

const NUDGE_AT = 2;
const ABORT_AT = 4;

interface ThrashState {
  /** Dispatch failures seen since the last protected-field flip (or op start). */
  failuresSinceFlip: number;
  /** A reactive flip has happened and no failure has landed after it yet. */
  awaitingRefail: boolean;
  /** Completed flip-then-refail cycles this op. */
  cycles: number;
  /** Distinct protected fields flipped reactively (for the message). */
  flippedFields: Set<string>;
  /** Head of the most recent failure content (for the message). */
  lastError: string;
  nudged: boolean;
}

function createState(): ThrashState {
  return {
    failuresSinceFlip: 0,
    awaitingRefail: false,
    cycles: 0,
    flippedFields: new Set(),
    lastError: "",
    nudged: false,
  };
}

export const thrashGuardMiddleware: CanonicalMiddleware = {
  name: "thrash-guard",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<ThrashState>(ctx.op.id, "thrash-guard", createState);
    // Args live on ctx.toolCalls; results carry only name/content/status.
    const argsById = new Map(ctx.toolCalls.map((c) => [c.toolCallId, c.args]));

    for (const tr of ctx.toolResults) {
      if (isDispatchFailure(tr.status)) {
        state.failuresSinceFlip++;
        state.lastError = tr.content.replace(/\s+/g, " ").trim().slice(0, 200);
        if (state.awaitingRefail) {
          state.awaitingRefail = false;
          state.cycles++;
        }
        continue;
      }
      if (tr.status === "ok" && tr.toolName !== "setting") {
        // A successful action proves the route produced forward progress.
        // Disarm both sides of the pending cycle so a later unrelated failure
        // cannot be misclassified as the refail for an old settings change.
        state.awaitingRefail = false;
        state.failuresSinceFlip = 0;
        continue;
      }
      if (tr.toolName !== "setting" || tr.status !== "ok") continue;
      const args = argsById.get(tr.toolCallId) as { field?: unknown } | undefined;
      const field = typeof args?.field === "string" ? args.field : "";
      if (!isProtectedSetting(field)) continue;
      // A flip with no failure behind it is not thrash — the user asked for
      // it, or the agent is configuring before acting. Only failure→flip arms
      // the cycle detector.
      if (state.failuresSinceFlip > 0) {
        state.awaitingRefail = true;
        state.flippedFields.add(field);
      }
      state.failuresSinceFlip = 0;
    }

    if (state.cycles >= ABORT_AT) {
      const fields = [...state.flippedFields].join(", ");
      const message =
        `\n\n${isWorkerOp(ctx) ? "Suspended" : "Stopped"}: ${state.cycles} settings changes (${fields}) ` +
        `did not resolve the repeated tool failures. Last error: ${state.lastError}`;
      ctx.onEvent?.({ type: "stream", delta: message });
      return isWorkerOp(ctx)
        ? { kind: "suspend", reason: "thrash-guard", message }
        : { kind: "abort", reason: "thrash-guard", message };
    }
    if (state.cycles >= NUDGE_AT && !state.nudged) {
      state.nudged = true;
      const fields = [...state.flippedFields].join(", ");
      return {
        kind: "nudge",
        reason: "thrash-guard",
        message:
          `You have changed settings (${fields}) ${state.cycles} times immediately after tool failures, ` +
          `and the failures are continuing:\n${state.lastError}\n\n` +
          "Flipping settings is not fixing the underlying problem. Stop routing around it: " +
          "(1) make no further settings changes, (2) tell the user exactly what is failing — quote the error, " +
          "(3) ask how they want to proceed. Only change another setting if the user explicitly asks for it.",
      };
    }
    return { kind: "continue" };
  },
};
