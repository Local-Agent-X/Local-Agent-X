/**
 * Approval + creation hallucination guards. Runs only when the model
 * emitted text but no tool calls (terminal-turn intent). Approval check
 * fires every turn; creation check only on iter 0 (legacy behavior —
 * mid-turn creation claims are usually about real follow-ups).
 *
 * Ordered BEFORE action-claim and self-check so the most blatant
 * hallucinations get caught with a specific nudge before falling
 * through to the generic reflection prompt.
 */

import type { LoopMiddleware } from "../types.js";
import { checkApprovalHallucination, checkCreationHallucination } from "../../agent-guards.js";

export const hallucinationCheckMiddleware: LoopMiddleware = {
  name: "hallucination-check",

  afterModelCall(ctx, result) {
    if (result.toolCalls.length > 0) return { kind: "continue" };
    const text = result.assistantContent;
    if (!text) return { kind: "continue" };

    const approvalNudge = checkApprovalHallucination(text);
    if (approvalNudge) {
      return { kind: "nudge", message: approvalNudge, reason: "approval-hallucination" };
    }

    if (ctx.iteration === 0) {
      const creationNudge = checkCreationHallucination(text);
      if (creationNudge) {
        return { kind: "nudge", message: creationNudge, reason: "creation-hallucination" };
      }
    }

    return { kind: "continue" };
  },
};
