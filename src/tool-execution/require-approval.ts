// Approval phase: HumanLayer-style gate for dangerous tools. Skipped for
// cron + delegated agents (no human watching) and for the Ari-whitelisted
// internal tools.

import { USER_HINTS, type ToolResult } from "../types.js";
import { getApprovalManager, toolNeedsApproval } from "../approval-manager.js";
import type { Phase } from "./context.js";
import { terminate } from "./context.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  if (!toolNeedsApproval(ctx.tc.name)) return;
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
