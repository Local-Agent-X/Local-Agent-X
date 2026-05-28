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
  checkWorkerHallucination,
} from "../../agent-guards/index.js";
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

    // Worker hallucination fires EVERY turn (not just turn 0). Narrative claims
    // about background workers/sub-agents that weren't actually spawned slip past
    // the creation-hallucination check (no first-person verb, no sentence-start
    // verb).
    //
    // No LLM second-opinion here: ctx.toolsCalledThisOp is built from
    // op_turns.toolCallSummary entries with resultStatus === "ok" (see
    // host.ts), so a "background worker is on it" claim with no successful
    // spawn-class call in the ledger is provably false. An LLM verifier on
    // top would only re-introduce the false-negative that let the live
    // 2026-05-23 PDF-worker hallucination through.
    const workerNudge = checkWorkerHallucination(text, ctx.toolsCalledThisOp);
    if (workerNudge) {
      return { kind: "nudge", message: workerNudge, reason: "worker-hallucination" };
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
