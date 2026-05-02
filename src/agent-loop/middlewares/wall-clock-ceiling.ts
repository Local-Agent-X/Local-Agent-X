/**
 * Wall-clock ceiling — abort a turn that's been running too long, but
 * only if no committing tool (write/bash/send_email/etc.) has fired.
 * Otherwise we'd kill long-but-productive turns mid-ship.
 */

import type { LoopMiddleware } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-loop.wall-clock-ceiling");

const DEFAULT_TURN_WALL_CLOCK_MS = 180_000;

export const wallClockCeilingMiddleware: LoopMiddleware = {
  name: "wall-clock-ceiling",

  beforeIteration(ctx) {
    const elapsed = Date.now() - ctx.turnStartMs;
    if (elapsed >= DEFAULT_TURN_WALL_CLOCK_MS && ctx.committingToolsThisTurn.size === 0) {
      logger.warn(`turn aborted: ${elapsed}ms elapsed without a committing tool`);
      return {
        kind: "abort",
        turn: {
          messages: ctx.messages,
          usage: {
            promptTokens: ctx.totalInput,
            completionTokens: ctx.totalOutput,
            totalTokens: ctx.totalInput + ctx.totalOutput,
          },
          stopReason: "error",
          errorMessage: `Wall-clock ceiling reached: ${elapsed}ms with no committing tool`,
        },
      };
    }
    return { kind: "continue" };
  },
};
