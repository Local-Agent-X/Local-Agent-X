/**
 * Self-check on terminal turns — when the model is about to end the
 * turn (no tool calls), scan recent tool results for unresolved errors
 * and inject a reflection prompt forcing the model to acknowledge or
 * dismiss them. Fires at most once per turn so the check can't spiral.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { detectUnresolvedErrors, buildReflectionPrompt } from "../../agent-guards.js";

const FIRED = new WeakSet<LoopContext>();

export const selfCheckMiddleware: LoopMiddleware = {
  name: "self-check",

  afterModelCall(ctx, result) {
    if (result.toolCalls.length > 0) return { kind: "continue" };
    if (FIRED.has(ctx)) return { kind: "continue" };
    const errors = detectUnresolvedErrors(ctx.messages);
    if (errors.length === 0) return { kind: "continue" };
    FIRED.add(ctx);
    return { kind: "nudge", message: buildReflectionPrompt(errors), reason: "self-check" };
  },
};
