/**
 * Epistemic grounding guard for operational claims. A model may use memory as
 * a search lead, but it may not turn stale memory or prior assistant prose into
 * a definitive explanation of runtime/security/policy state.
 */
import { checkUnsupportedOperationalClaim, OPERATIONAL_CLAIM_REASON } from "../../agent-guards/index.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

interface FiredFlag { fired: boolean }

export const operationalClaimMiddleware: CanonicalMiddleware = {
  name: "operational-claim",

  afterModelCall(ctx) {
    // A mixed reasoning+tool turn is not the final answer yet. Let the
    // requested inspection run; the next model turn is checked against the
    // successful op-level evidence set. Blocking here would prevent the model
    // from gathering the very evidence this guard requires.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "operational-claim",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };

    const nudge = checkUnsupportedOperationalClaim(
      ctx.assistantContent,
      ctx.toolsCalledThisOp,
    );
    if (!nudge) return { kind: "continue" };

    flag.fired = true;
    return { kind: "nudge", message: nudge, reason: OPERATIONAL_CLAIM_REASON };
  },
};
