/**
 * Verify-gate middleware — autonomous worker edited source code but never ran
 * a build / type-check / test before wrapping up. Accumulate edit-vs-verify
 * evidence after each turn's dispatch; at wrap-up (model ends tool-lessly with
 * text, same signal premature-completion keys on) nudge once to verify.
 *
 * Worker ops only (isWorkerOp) — interactive turns show results live and the
 * user verifies. Mutually exclusive with premature-completion: that guard
 * bails when committing tools ran this op, this one fires only when they did
 * (an edit IS a committing tool), so the two never contend for the same turn.
 *
 * Detection logic lives in src/agent-guards/verify-gate.ts; this is the thin
 * canonical wiring.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  noteVerifyEvidence,
  checkVerifyGate,
  createVerifyGateState,
  type VerifyGateState,
  type VerifyTurnAction,
} from "../../agent-guards/index.js";

function buildActions(
  toolCalls: { toolCallId: string; tool: string; args: unknown }[],
  toolResults: { toolCallId: string; status?: "ok" | "error" | "cancelled" }[],
): VerifyTurnAction[] {
  const statusById = new Map(toolResults.map(tr => [tr.toolCallId, tr.status]));
  return toolCalls.map(tc => {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const filePath =
      typeof args.file_path === "string" ? args.file_path
      : typeof args.path === "string" ? args.path
      : undefined;
    return {
      tool: tc.tool,
      filePath,
      command: typeof args.command === "string" ? args.command : undefined,
      status: statusById.get(tc.toolCallId),
    };
  });
}

export const verifyGateMiddleware: CanonicalMiddleware = {
  name: "verify-gate",
  when: isWorkerOp,

  afterToolExecution(ctx) {
    const state = getMiddlewareState<VerifyGateState>(
      ctx.op.id,
      "verify-gate",
      createVerifyGateState,
    );
    noteVerifyEvidence(buildActions(ctx.toolCalls, ctx.toolResults), state);
    return { kind: "continue" };
  },

  afterModelCall(ctx) {
    // Only evaluate at wrap-up: model ended the turn with text and no tool
    // calls. Mirrors premature-completion's wrap-up detection.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    const state = getMiddlewareState<VerifyGateState>(
      ctx.op.id,
      "verify-gate",
      createVerifyGateState,
    );
    const r = checkVerifyGate(state);
    if (r.nudge) return { kind: "nudge", message: r.nudge, reason: "verify-gate" };
    return { kind: "continue" };
  },
};
