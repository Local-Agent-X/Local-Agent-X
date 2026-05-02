/**
 * Token ceiling — hard cap on input + output tokens per turn. Stops
 * runaway burns where the loop keeps calling tools that produce big
 * results without ever wrapping up.
 *
 * Default: 500k tokens combined. Aborts the turn cleanly with a
 * stop_reason that downstream UI can render distinctly from end_turn.
 */

import type { LoopMiddleware } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-loop.token-ceiling");

const DEFAULT_TURN_TOKEN_CEILING = 500_000;

export const tokenCeilingMiddleware: LoopMiddleware = {
  name: "token-ceiling",

  beforeIteration(ctx) {
    const ceiling = DEFAULT_TURN_TOKEN_CEILING;
    const used = ctx.totalInput + ctx.totalOutput;
    if (used >= ceiling) {
      logger.warn(`turn aborted: ${used} >= ${ceiling} tokens`);
      return {
        kind: "abort",
        turn: {
          messages: ctx.messages,
          usage: {
            promptTokens: ctx.totalInput,
            completionTokens: ctx.totalOutput,
            totalTokens: used,
          },
          stopReason: "error",
          errorMessage: `Token ceiling reached: ${used} >= ${ceiling}`,
        },
      };
    }
    return { kind: "continue" };
  },
};
