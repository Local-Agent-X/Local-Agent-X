/**
 * Action-claim verification — when the assistant says "Removed X" or
 * "Saved Y" but never invoked the matching tool, push back. Fires at
 * most once per turn so it can't spiral.
 *
 * Runs only on terminal turns (no tool calls this iteration). Lives
 * after the post-turn detectors + hallucination checks so it catches
 * the residual "I did Z" claims that aren't approval/creation shapes.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { checkUnmatchedActionClaim } from "../../agent-guards.js";

const FIRED = new WeakSet<LoopContext>();

export const actionClaimMiddleware: LoopMiddleware = {
  name: "action-claim",

  afterModelCall(ctx, result) {
    if (result.toolCalls.length > 0) return { kind: "continue" };
    if (FIRED.has(ctx)) return { kind: "continue" };
    const nudge = checkUnmatchedActionClaim(result.assistantContent, ctx.toolsCalledThisTurn);
    if (nudge) {
      FIRED.add(ctx);
      return { kind: "nudge", message: nudge, reason: "action-claim" };
    }
    return { kind: "continue" };
  },
};
