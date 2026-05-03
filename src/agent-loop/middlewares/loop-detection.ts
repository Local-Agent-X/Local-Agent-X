/**
 * Tool-loop detector — checkToolLoops with model-tier-aware thresholds.
 * When the model keeps calling the same tool with the same arguments,
 * inject a nudge or abort the turn entirely. Tighter thresholds for
 * weak/medium models that loop more readily.
 *
 * Runs in afterModelCall so it sees this iteration's tool calls
 * before tool execution.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { checkToolLoops, createLoopState, type LoopState } from "../../agent-guards.js";

const STATE = new WeakMap<LoopContext, LoopState>();

function getState(ctx: LoopContext): LoopState {
  let s = STATE.get(ctx);
  if (!s) {
    s = createLoopState();
    STATE.set(ctx, s);
  }
  return s;
}

export const loopDetectionMiddleware: LoopMiddleware = {
  name: "loop-detection",

  async afterModelCall(ctx, result) {
    if (result.toolCalls.length === 0) return { kind: "continue" };
    const { classifyModel } = await import("../../model-tiers.js");
    const modelTier = classifyModel(ctx.req.model);
    const r = checkToolLoops(result.toolCalls, getState(ctx), { modelTier });
    if (r.abort) {
      ctx.req.onEvent?.({ type: "stream", delta: r.nudge || "" });
      return {
        kind: "abort",
        turn: {
          messages: ctx.messages,
          usage: {
            promptTokens: ctx.totalInput,
            completionTokens: ctx.totalOutput,
            totalTokens: ctx.totalInput + ctx.totalOutput,
          },
          stopReason: "end_turn",
        },
      };
    }
    if (r.nudge) {
      return { kind: "nudge", message: r.nudge, reason: "loop-detection" };
    }
    return { kind: "continue" };
  },
};
