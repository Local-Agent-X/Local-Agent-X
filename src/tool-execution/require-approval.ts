// Approval phase: profile-gated user consent for tool calls. Branches on the
// four-valued Decision from the active autonomy profile. In an unattended run
// (cron/delegated) there is no human to prompt, so the profile IS the
// authorization contract: "ask" tiers block, and only "allow" /
// "allow-with-rollback" proceed. Run such a job under Autonomous (or pin a
// per-job profile) to grant the tiers it needs.

import { USER_HINTS, type ToolResult } from "../types.js";
import {
  getApprovalManager,
  getToolDecision,
  decisionRequiresPrompt,
  decisionDenies,
  requiresIrreversibleConfirm,
} from "../approval-manager.js";
import type { Phase } from "./context.js";
import { terminate, CONTINUE } from "./context.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  const decision = getToolDecision(ctx.tc.name, ctx.sessionId);

  if (decisionDenies(decision)) {
    const result: ToolResult = {
      content: `BLOCKED by profile: ${ctx.tc.name} (risk class denied)`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }

  // Irreversible operations always confirm, even under a relaxed profile that
  // would otherwise auto-allow them.
  const destructive = requiresIrreversibleConfirm(ctx.tc.name, ctx.args);
  if (!decisionRequiresPrompt(decision) && !destructive) return CONTINUE;

  // Unattended run: no human to prompt. If the profile granted this action
  // (allow / allow-with-rollback) the irreversible-confirm floor can't run a
  // prompt, but the chosen profile already opted in — let it proceed. If the
  // profile itself says "ask", nothing authorized it, so block rather than
  // silently run (this is the load-bearing guarantee for cron/delegated runs).
  if (ctx.callContext !== "local") {
    if (!decisionRequiresPrompt(decision)) return CONTINUE;
    const result: ToolResult = {
      content:
        `BLOCKED (unattended): ${ctx.tc.name} needs approval the active autonomy ` +
        `profile reserves for a human, but no one is watching this ${ctx.callContext} run. ` +
        `Run this under the Autonomous profile (or pin a per-job profile) to allow it.`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }
  if (!ctx.onEvent) return CONTINUE;

  const approved = await getApprovalManager().requestApproval({
    toolName: ctx.tc.name,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context: destructive
      ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approvalContext}`
      : ctx.approvalContext,
    args: ctx.args,
    alwaysAsk: !!destructive,
    emit: ctx.onEvent,
  });
  if (approved) return CONTINUE;

  const result: ToolResult = {
    content: `BLOCKED by user: declined approval for ${ctx.tc.name}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "approval", userHint: USER_HINTS.policy },
  };
  return terminate(ctx, { rendered: "model", result, allowed: false });
};
