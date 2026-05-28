/**
 * Action-claim verification — when the assistant says "Removed X" / "Saved Y"
 * but never invoked the matching tool, push back. Canonical-loop port of
 * src/agent-loop/middlewares/action-claim.ts.
 *
 * Fires at most once per OP (legacy fires at most once per turn; canonical's
 * "turn" of legacy maps to "op" in canonical, so the per-op fired flag is
 * the equivalent guard).
 */
import type { CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { checkUnmatchedActionClaim } from "../../agent-guards/index.js";
import { verifyClaimHallucinationWithLLM } from "../../classifiers/claim-verify.js";

interface FiredFlag { fired: boolean }

export const actionClaimMiddleware: CanonicalMiddleware = {
  name: "action-claim",

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "action-claim",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    const nudge = checkUnmatchedActionClaim(ctx.assistantContent, ctx.toolsCalledThisOp);
    if (!nudge) return { kind: "continue" };

    const confirmed = await verifyClaimHallucinationWithLLM(
      ctx.assistantContent,
      Array.from(ctx.toolsCalledThisOp),
    );
    if (confirmed === false) return { kind: "continue" };
    flag.fired = true;
    return { kind: "nudge", message: nudge, reason: "action-claim" };
  },
};
