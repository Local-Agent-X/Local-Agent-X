/**
 * Mid-turn evidence-staleness check. Canonical-loop port of
 * src/agent-loop/middlewares/mid-turn-stale.ts.
 *
 * Legacy fires "after MIN_ITERATION iterations" within one turn. Canonical
 * maps "iteration" → "turn", so this fires when `turnIdx >= MIN_ITERATION`
 * and the per-turn evidence count (maintained across turns in
 * ctx.evidenceHistory) has been flat for STALE_WINDOW consecutive turns
 * with no committing tool calls.
 *
 * Two-strike: first staleness window nudges; second aborts.
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.mid-turn-stale");

const MIN_ITERATION = 5;
const STALE_WINDOW = 3;

interface NudgedFlag { nudged: boolean }

const STALE_NUDGE = [
  "Your last 3 actions produced no new evidence — same tools, same arguments, same empty results. You're spinning. Change approach NOW:",
  "  - If you're using browser.evaluate or browser.click on a new page, FIRST call browser.snapshot to see the actual DOM and find correct selectors.",
  "  - If a tool keeps returning the same error, read the error text and use a different tool / different arguments.",
  "  - If you're stuck on auth / captcha / login, ask the user to help instead of retrying.",
  "If the next iteration also produces no new evidence, the turn will be aborted automatically.",
].join("\n");

export const midTurnStaleMiddleware: CanonicalMiddleware = {
  name: "mid-turn-stale",

  // NOT gated to worker ops: the second-strike abort is the circuit-breaker
  // that caps a spinning interactive/voice turn. Gating it off let a looping
  // voice turn spam to max-iterations.
  beforeTurn(ctx) {
    if (ctx.turnIdx < MIN_ITERATION) return { kind: "continue" };
    if (ctx.committingToolsThisOp.size > 0) return { kind: "continue" };
    if (ctx.evidenceHistory.length < STALE_WINDOW) return { kind: "continue" };

    const tail = ctx.evidenceHistory.slice(-STALE_WINDOW);
    const allEqual = tail.every(v => v === tail[0]);
    if (!allEqual) return { kind: "continue" };

    const flag = getMiddlewareState<NudgedFlag>(
      ctx.op.id,
      "mid-turn-stale",
      () => ({ nudged: false }),
    );

    if (!flag.nudged) {
      flag.nudged = true;
      logger.warn(`first-strike nudge: evidence flat for ${STALE_WINDOW} turns`);
      return { kind: "nudge", message: STALE_NUDGE, reason: "stale-warning" };
    }

    logger.warn(`second-strike abort: evidence still flat after nudge`);
    return {
      kind: "abort",
      reason: "mid-turn-stale",
      message: "Mid-turn evidence stale (no progress after recovery nudge — likely browser tool selectors blind, auth wall, or wrong tool for the job)",
    };
  },
};
