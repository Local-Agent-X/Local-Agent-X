/**
 * Dead-end detector — 3 empty tool results in a row → nudge a re-plan.
 * Canonical-loop port of src/agent-loop/middlewares/dead-end.ts.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkDeadEnd,
  createDeadEndState,
  type DeadEndState,
} from "../../agent-guards/index.js";

export const deadEndMiddleware: CanonicalMiddleware = {
  name: "dead-end",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<DeadEndState>(
      ctx.op.id,
      "dead-end",
      createDeadEndState,
    );
    for (const tr of ctx.toolResults) {
      const d = checkDeadEnd(tr.toolName, tr.content, state);
      if (d.nudge) {
        return { kind: "nudge", message: d.nudge, reason: "dead-end" };
      }
    }
    return { kind: "continue" };
  },
};
