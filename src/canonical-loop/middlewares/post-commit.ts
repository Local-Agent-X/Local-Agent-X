/**
 * Post-commit nudge — when bash output shows a successful git commit,
 * inject a wrap-up nudge on the NEXT turn so the agent doesn't keep
 * grinding past a real ship under the perma-fix mandate.
 *
 * Canonical-loop port of src/agent-loop/middlewares/post-commit.ts. The
 * per-op state lives in the middleware-state registry keyed under
 * `post-commit` — sibling to loop-detection's `LoopState` but kept
 * separate so the two middlewares can clear independently in tests.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkPostCommit,
  createLoopState,
  type LoopState,
} from "../../agent-guards.js";

export const postCommitMiddleware: CanonicalMiddleware = {
  name: "post-commit",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<LoopState>(
      ctx.op.id,
      "post-commit",
      createLoopState,
    );
    const flat = ctx.toolResults.map(tr => ({
      name: tr.toolName,
      result: tr.content,
    }));
    const pc = checkPostCommit(flat, state);
    if (pc.nudge) {
      return { kind: "nudge", message: pc.nudge, reason: "post-commit" };
    }
    return { kind: "continue" };
  },
};
