/**
 * Action-claim verification — when the assistant says "Removed X" or
 * "Saved Y" but never invoked the matching tool, push back. Fires at
 * most once per turn so it can't spiral.
 *
 * Hybrid: regex catches the obvious claim shape (cheap pre-filter, ~5% of
 * terminal replies trip it). When regex says "claim shape detected and no
 * matching tool called", an LLM second opinion confirms or vetoes — this
 * eliminates the false positives that historically forced retries on
 * legitimate recaps ("I noted in the bash output...") and diagnostics ("the
 * issue is in commit abc1234"). LLM unavailable → fall back to firing the
 * regex's verdict (fail-safe toward existing behavior).
 *
 * Runs only on terminal turns (no tool calls this iteration). Lives after
 * the post-turn detectors + hallucination checks so it catches the residual
 * "I did Z" claims that aren't approval/creation shapes.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";
import { checkUnmatchedActionClaim } from "../../agent-guards.js";
import { verifyClaimHallucinationWithLLM } from "../../classifiers/claim-verify.js";

const FIRED = new WeakSet<LoopContext>();

export const actionClaimMiddleware: LoopMiddleware = {
  name: "action-claim",

  async afterModelCall(ctx, result) {
    if (result.toolCalls.length > 0) return { kind: "continue" };
    if (FIRED.has(ctx)) return { kind: "continue" };
    const nudge = checkUnmatchedActionClaim(result.assistantContent, ctx.toolsCalledThisTurn);
    if (!nudge) return { kind: "continue" };

    // Regex says "claim with no matching tool". Ask LLM to confirm.
    const confirmed = await verifyClaimHallucinationWithLLM(
      result.assistantContent,
      Array.from(ctx.toolsCalledThisTurn),
    );
    if (confirmed === false) {
      // LLM vetoed — false positive. Don't fire the nudge.
      return { kind: "continue" };
    }
    // confirmed === true OR null (LLM unavailable) → fire nudge as before.
    FIRED.add(ctx);
    return { kind: "nudge", message: nudge, reason: "action-claim" };
  },
};
