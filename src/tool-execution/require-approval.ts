// Approval phase: profile-gated user consent for tool calls. Skipped for
// cron + delegated agents (no human watching). Branches on the four-valued
// Decision from the active autonomy profile.

import { USER_HINTS, type ToolResult } from "../types.js";
import {
  getApprovalManager,
  getToolDecision,
  decisionRequiresPrompt,
  decisionDenies,
  isDestructiveCommand,
} from "../approval-manager.js";
import type { Phase } from "./context.js";
import { terminate, CONTINUE } from "./context.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  const decision = getToolDecision(ctx.tc.name);

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
  const destructive = isDestructiveCommand(ctx.tc.name, ctx.args);
  if (!decisionRequiresPrompt(decision) && !destructive) return CONTINUE;
  if (ctx.callContext !== "local") return CONTINUE;
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
