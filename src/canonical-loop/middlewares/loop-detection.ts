/**
 * Tool-loop detector — checkToolLoops with model-tier-aware thresholds.
 * Canonical-loop port of src/agent-loop/middlewares/loop-detection.ts.
 *
 * Fires in afterModelCall so it sees this turn's tool calls before dispatch.
 * State is per-op so the lastToolKey / sameToolCount carry across turns.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkToolLoops,
  noteToolResults,
  createLoopState,
  type LoopState,
} from "../../agent-guards/index.js";

function toLoopCalls(toolCalls: { tool: string; args: unknown }[]): { name: string; arguments: string }[] {
  return toolCalls.map(tc => ({
    name: tc.tool,
    arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
  }));
}

export const loopDetectionMiddleware: CanonicalMiddleware = {
  name: "loop-detection",
  when: isWorkerOp,

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const { classifyModel } = await import("../../model-tiers.js");
    const modelTier = classifyModel(ctx.model);
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const r = checkToolLoops(toLoopCalls(ctx.toolCalls), state, { modelTier });
    if (r.abort) {
      ctx.onEvent?.({ type: "stream", delta: r.nudge || "" });
      return { kind: "abort", reason: "loop-detection", message: r.nudge || undefined };
    }
    if (r.nudge) {
      return { kind: "nudge", message: r.nudge, reason: "loop-detection" };
    }
    return { kind: "continue" };
  },

  // Record this turn's results so exact-repeat can distinguish a stuck spin
  // (same call, same result) from legitimate repetition (same call, changing
  // result — user-requested batches, polling, progressing retries).
  async afterToolExecution(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    noteToolResults(toLoopCalls(ctx.toolCalls), state, ctx.toolResults);
    return { kind: "continue" };
  },
};
