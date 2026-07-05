/**
 * Codebase-advice grounding — if the user asks for repo/harness implementation
 * direction, a model must inspect current code before recommending the next
 * move. Docs, memory, and prior assistant summaries are leads, not proof.
 */
import {
  CODEBASE_ADVICE_GROUNDING_REASON,
  checkUngroundedCodebaseAdvice,
} from "../../agent-guards/index.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

interface FiredFlag { fired: boolean }

export const codebaseAdviceMiddleware: CanonicalMiddleware = {
  name: "codebase-advice",

  afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "codebase-advice",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };

    const nudge = checkUngroundedCodebaseAdvice(
      ctx.userMessage,
      ctx.assistantContent,
      ctx.toolsCalledThisOp,
    );
    if (!nudge) return { kind: "continue" };

    flag.fired = true;
    return { kind: "nudge", message: nudge, reason: CODEBASE_ADVICE_GROUNDING_REASON };
  },
};
