/**
 * Post-commit nudge — when bash output shows a successful git commit,
 * inject a wrap-up nudge on the NEXT iteration so the agent doesn't
 * keep grinding past a real ship under the perma-fix mandate.
 *
 * Per-turn state lives in a WeakMap keyed on LoopContext so the
 * detector remembers the pending flag across iterations.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { checkPostCommit, createLoopState, type LoopState } from "../../agent-guards.js";

const STATE = new WeakMap<LoopContext, LoopState>();

function getState(ctx: LoopContext): LoopState {
  let s = STATE.get(ctx);
  if (!s) {
    s = createLoopState();
    STATE.set(ctx, s);
  }
  return s;
}

export const postCommitMiddleware: LoopMiddleware = {
  name: "post-commit",

  afterToolExecution(ctx, toolResults) {
    const flat = toolResults.map(tr => ({
      name: ctx.toolCalls.find(tc => tc.id === (tr as { tool_call_id?: string }).tool_call_id)?.name || "unknown",
      result: typeof tr.content === "string" ? tr.content : "",
    }));
    const pc = checkPostCommit(flat, getState(ctx));
    if (pc.nudge) {
      return { kind: "nudge", message: pc.nudge, reason: "post-commit" };
    }
    return { kind: "continue" };
  },
};
