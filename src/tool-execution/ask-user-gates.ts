/**
 * The gates that put a call to the user instead of refusing it. Each sets
 * ctx.policyApprovalReason — the channel that asks a person under every
 * autonomy profile and refuses an unattended run (require-approval.ts):
 * private content to a destination the user did not choose, a write to a file
 * the app later acts on, a vault secret handed to an MCP server, and a call
 * its own tool says needs the user (ToolDefinition.confirmWithUser).
 */
import type { ToolCallContext } from "./context.js";
import { currentHumanText } from "./unnamed-delete-gate.js";
import { privateContentGate } from "./private-content-gate.js";
import { controlFileGate } from "./control-file-gate.js";
import { mcpSecretUseGate } from "../tools/mcp-admin-tools.js";

/** Only the tool can see what a call would touch — which fact a substring
 *  selects and whose it is — so the tool says why this one needs the user. */
export function toolConfirmationGate(ctx: Pick<ToolCallContext, "tool" | "args" | "priorMessages" | "policyApprovalReason">): void {
  const reason = ctx.tool?.confirmWithUser?.(ctx.args, { userText: currentHumanText(ctx.priorMessages) });
  if (!reason) return;
  if (!ctx.policyApprovalReason) ctx.policyApprovalReason = reason;
  else if (!ctx.policyApprovalReason.includes(reason)) ctx.policyApprovalReason += `; ${reason}`;
}

export async function askUserGates(ctx: ToolCallContext): Promise<void> {
  await privateContentGate(ctx);
  controlFileGate(ctx);
  mcpSecretUseGate(ctx);
  toolConfirmationGate(ctx);
}
