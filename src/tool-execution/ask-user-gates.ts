/**
 * The gates that put a call to the user instead of refusing it. Each sets
 * ctx.policyApprovalReason — the channel that asks a person under every
 * autonomy profile and refuses an unattended run (require-approval.ts):
 * private content to a destination the user did not choose, a write to a file
 * the app later acts on, a vault secret handed to an MCP server, a call its
 * own tool says needs the user (ToolDefinition.confirmWithUser), a write
 * into the same folder another live agent is changing (claim-clash-gate.ts,
 * which otherwise only notes the clash on the result), and an
 * outward call made after a tool result held a planted-looking instruction
 * (injection-exposure.ts).
 */
import type { ToolCallContext } from "./context.js";
import { currentHumanText } from "./unnamed-delete-gate.js";
import { privateContentGate } from "./private-content-gate.js";
import { controlFileGate } from "./control-file-gate.js";
import { claimClashGate } from "./claim-clash-gate.js";
import { injectionExposureGate } from "./injection-exposure.js";
import { mcpSecretUseGate } from "../tools/mcp-admin-tools.js";
import { addApprovalReason } from "./approval-card-text.js";

/** Only the tool can see what a call would touch — which fact a substring
 *  selects and whose it is — so the tool says why this one needs the user. */
export function toolConfirmationGate(ctx: Pick<ToolCallContext, "tool" | "args" | "priorMessages" | "policyApprovalReason">): void {
  const reason = ctx.tool?.confirmWithUser?.(ctx.args, { userText: currentHumanText(ctx.priorMessages) });
  if (!reason) return;
  addApprovalReason(ctx, reason);
}

export async function askUserGates(ctx: ToolCallContext): Promise<void> {
  await privateContentGate(ctx);
  controlFileGate(ctx);
  claimClashGate(ctx);
  mcpSecretUseGate(ctx);
  toolConfirmationGate(ctx);
  injectionExposureGate(ctx);
}
