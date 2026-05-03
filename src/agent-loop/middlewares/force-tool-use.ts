/**
 * Force tool use on iteration 0 for build/action intents. Sets the
 * adapter's toolChoice to "required" so the model has to call a tool
 * instead of replying with a plan.
 *
 * Currently a forward-compatible shim: it sets req.toolChoice but the
 * unified loop body does not yet thread that field through to
 * adapter.stream. Once run.ts is updated to forward toolChoice, this
 * middleware activates without further changes.
 */

import type { LoopMiddleware } from "../types.js";

const BUILD_INTENT_RE = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script|file|document|spreadsheet)/i;
const ACTION_INTENT_RE = /\b(schedule|save|remember|send|post|delete|update|run|execute|launch|open|close|deploy|install)\b/i;

export const forceToolUseMiddleware: LoopMiddleware = {
  name: "force-tool-use",

  beforeIteration(ctx) {
    const reqMut = ctx.req as { toolChoice?: "auto" | "required" };
    if (ctx.iteration === 0) {
      const msg = ctx.req.userMessage || "";
      if (BUILD_INTENT_RE.test(msg) || ACTION_INTENT_RE.test(msg)) {
        reqMut.toolChoice = "required";
      }
    } else {
      // Reset on iter > 0 — legacy run-anthropic.ts only sends "required" on
      // iter 0; subsequent iterations use "auto" so the model can choose to
      // emit a final answer text instead of being forced into another tool.
      reqMut.toolChoice = "auto";
    }
    return { kind: "continue" };
  },
};
