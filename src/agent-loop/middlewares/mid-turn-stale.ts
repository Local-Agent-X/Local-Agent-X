/**
 * Mid-turn evidence-staleness check. After MIN_ITERATION iterations,
 * look at the last STALE_WINDOW evidence counts. If they're flat AND
 * no committing tool has fired, the agent is spinning without progress.
 *
 * Two-strike behavior: first staleness window fires a NUDGE (gives the
 * agent a clear hint to change approach — e.g., snapshot before
 * evaluate). Only the SECOND consecutive staleness window (after the
 * agent ignored the nudge) aborts the turn. Prevents the "5 blind
 * browser.evaluate calls -> silent abort" pattern where the agent
 * never gets told why its approach is failing.
 *
 * Differs from the post-turn staleness check (which only fires at exit)
 * by catching stuck-in-middle cases too.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-loop.mid-turn-stale");

const MIN_ITERATION = 5;
const STALE_WINDOW = 3;

const NUDGED = new WeakSet<LoopContext>();

const STALE_NUDGE = [
  "Your last 3 actions produced no new evidence — same tools, same arguments, same empty results. You're spinning. Change approach NOW:",
  "  - If you're using browser.evaluate or browser.click on a new page, FIRST call browser.snapshot to see the actual DOM and find correct selectors.",
  "  - If a tool keeps returning the same error, read the error text and use a different tool / different arguments.",
  "  - If you're stuck on auth / captcha / login, ask the user to help instead of retrying.",
  "If the next iteration also produces no new evidence, the turn will be aborted automatically.",
].join("\n");

export const midTurnStaleMiddleware: LoopMiddleware = {
  name: "mid-turn-stale",

  beforeIteration(ctx) {
    if (ctx.iteration < MIN_ITERATION) return { kind: "continue" };
    if (ctx.committingToolsThisTurn.size > 0) return { kind: "continue" };
    if (ctx.evidenceHistory.length < STALE_WINDOW) return { kind: "continue" };

    const tail = ctx.evidenceHistory.slice(-STALE_WINDOW);
    const allEqual = tail.every(v => v === tail[0]);
    if (!allEqual) return { kind: "continue" };

    if (!NUDGED.has(ctx)) {
      // First strike: warn the agent, give specific recovery hints.
      NUDGED.add(ctx);
      logger.warn(`first-strike nudge: evidence flat for ${STALE_WINDOW} iterations`);
      return { kind: "nudge", message: STALE_NUDGE, reason: "stale-warning" };
    }

    // Second strike: agent ignored the nudge. Abort.
    logger.warn(`second-strike abort: evidence still flat after nudge`);
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
        errorMessage: `Mid-turn evidence stale (no progress after recovery nudge — likely browser tool selectors blind, auth wall, or wrong tool for the job)`,
      },
    };
  },
};
