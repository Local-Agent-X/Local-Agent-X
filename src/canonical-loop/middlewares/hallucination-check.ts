/**
 * Approval + creation hallucination guards. Canonical-loop port of
 * src/agent-loop/middlewares/hallucination-check.ts.
 *
 * Fires on terminal-shaped turns (assistant text, no tool calls). Approval
 * check fires every turn; creation check only on turn 0 (the canonical
 * analogue of legacy `ctx.iteration === 0` — first turn of the op).
 */
import type { CanonicalMiddleware } from "./types.js";
import {
  checkApprovalHallucination,
  checkCreationHallucination,
} from "../../agent-guards.js";
import { verifyClaimHallucinationWithLLM } from "../../classifiers/claim-verify.js";

export const hallucinationCheckMiddleware: CanonicalMiddleware = {
  name: "hallucination-check",

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    const text = ctx.assistantContent;
    if (!text) return { kind: "continue" };

    const approvalNudge = checkApprovalHallucination(text);
    if (approvalNudge) {
      return { kind: "nudge", message: approvalNudge, reason: "approval-hallucination" };
    }

    if (ctx.turnIdx === 0) {
      const creationNudge = checkCreationHallucination(text);
      if (creationNudge) {
        const confirmed = await verifyClaimHallucinationWithLLM(
          text,
          Array.from(ctx.toolsCalledThisOp),
        );
        if (confirmed === false) return { kind: "continue" };
        return { kind: "nudge", message: creationNudge, reason: "creation-hallucination" };
      }
    }

    return { kind: "continue" };
  },
};
