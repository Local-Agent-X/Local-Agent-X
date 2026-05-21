// Approval phase: profile-gated user consent for tool calls. Skipped for
// cron + delegated agents (no human watching). Branches on the four-valued
// Decision from the active autonomy profile.

import { USER_HINTS, type ToolResult } from "../types.js";
import {
  getApprovalManager,
  getToolDecision,
  decisionRequiresPrompt,
  decisionDenies,
} from "../approval-manager.js";
import type { Phase } from "./context.js";
import { terminate } from "./context.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  const decision = getToolDecision(ctx.tc.name);

  if (decisionDenies(decision)) {
    const result: ToolResult = {
      content: `BLOCKED by profile: ${ctx.tc.name} (risk class denied)`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    terminate(ctx, { rendered: "model", result, allowed: false });
    return;
  }

  if (!decisionRequiresPrompt(decision)) return;
  if (ctx.callContext !== "local") return;
  if (!ctx.onEvent) return;

  const approved = await getApprovalManager().requestApproval({
    toolName: ctx.tc.name,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context: ctx.approvalContext,
    args: ctx.args,
    emit: ctx.onEvent,
  });
  if (approved) return;

  const result: ToolResult = {
    content: `BLOCKED by user: declined approval for ${ctx.tc.name}`,
    isError: true,
    status: "blocked",
    metadata: { layer: "approval", userHint: USER_HINTS.policy },
  };
  terminate(ctx, { rendered: "model", result, allowed: false });
};
