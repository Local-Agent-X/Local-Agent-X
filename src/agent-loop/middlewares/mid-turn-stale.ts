/**
 * Mid-turn evidence-staleness check. After MID_TURN_MIN_ITERATION
 * iterations, look at the last MID_TURN_EVIDENCE_STALE_WINDOW evidence
 * counts. If they're flat AND no committing tool has fired, abort —
 * the agent is spinning without progress.
 *
 * Differs from the post-turn staleness check (which only fires at exit)
 * by catching stuck-in-middle cases too.
 */

import type { LoopMiddleware } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-loop.mid-turn-stale");

const MIN_ITERATION = 5;
const STALE_WINDOW = 3;

export const midTurnStaleMiddleware: LoopMiddleware = {
  name: "mid-turn-stale",

  beforeIteration(ctx) {
    if (ctx.iteration < MIN_ITERATION) return { kind: "continue" };
    if (ctx.committingToolsThisTurn.size > 0) return { kind: "continue" };
    if (ctx.evidenceHistory.length < STALE_WINDOW) return { kind: "continue" };

    const tail = ctx.evidenceHistory.slice(-STALE_WINDOW);
    const allEqual = tail.every(v => v === tail[0]);
    if (!allEqual) return { kind: "continue" };

    logger.warn(`turn aborted: evidence flat for last ${STALE_WINDOW} iterations`);
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
        errorMessage: `Mid-turn evidence stale (last ${STALE_WINDOW} iterations flat, no committing tool)`,
      },
    };
  },
};
