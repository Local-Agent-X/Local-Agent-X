/**
 * Tool-loop detector — checkToolLoops with model-tier-aware thresholds.
 * Canonical-loop port of src/agent-loop/middlewares/loop-detection.ts.
 *
 * Fires in afterModelCall so it sees this turn's tool calls before dispatch.
 * State is per-op so the lastToolKey / sameToolCount carry across turns.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkToolLoops,
  createLoopState,
  type LoopState,
} from "../../agent-guards.js";

export const loopDetectionMiddleware: CanonicalMiddleware = {
  name: "loop-detection",

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const { classifyModel } = await import("../../model-tiers.js");
    const modelTier = classifyModel(ctx.model);
    const calls = ctx.toolCalls.map(tc => ({
      name: tc.tool,
      arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
    }));
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const r = checkToolLoops(calls, state, { modelTier });
    if (r.abort) {
      ctx.onEvent?.({ type: "stream", delta: r.nudge || "" });
      return { kind: "abort", reason: "loop-detection", message: r.nudge || undefined };
    }
    if (r.nudge) {
      return { kind: "nudge", message: r.nudge, reason: "loop-detection" };
    }
    return { kind: "continue" };
  },
};
