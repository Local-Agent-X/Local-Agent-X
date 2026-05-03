/**
 * Dead-end detector — 3 empty tool results in a row → nudge a re-plan.
 * Catches "grep 50 files, 0 matches" / "search returns nothing" loops
 * before they burn the rest of the iteration budget.
 *
 * Per-turn state lives in a WeakMap keyed on LoopContext so the
 * consecutive counter persists across iterations of the same turn.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { checkDeadEnd, createDeadEndState, type DeadEndState } from "../../agent-guards.js";

const STATE = new WeakMap<LoopContext, DeadEndState>();

function getState(ctx: LoopContext): DeadEndState {
  let s = STATE.get(ctx);
  if (!s) {
    s = createDeadEndState();
    STATE.set(ctx, s);
  }
  return s;
}

export const deadEndMiddleware: LoopMiddleware = {
  name: "dead-end",

  afterToolExecution(ctx, toolResults) {
    const state = getState(ctx);
    for (const tr of toolResults) {
      const content = typeof tr.content === "string" ? tr.content : "";
      const toolName = ctx.toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown";
      const d = checkDeadEnd(toolName, content, state);
      if (d.nudge) {
        return { kind: "nudge", message: d.nudge, reason: "dead-end" };
      }
    }
    return { kind: "continue" };
  },
};
