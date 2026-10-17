// Run a call the user approved from the inbox: once, through the whole
// pipeline, as the run that parked it would have run it. The inbox
// (src/inbox/approvals.ts) decides WHETHER it runs; this decides HOW.
//
// It is an out-of-turn caller of executeToolCalls, like routes/mcp.ts and the
// memory canary, and no gate is skipped. The user's yes is a one-shot grant on
// the ApprovalManager for exactly this call in its session; the gates that
// would park, refuse or prompt for want of a person consume it
// (deferred-call.ts takeUserGrant). Every other gate judges the call now:
// policy and kill switches as they stand today, Ari, RBAC as the role the run
// dispatched with (never the user's), the threat engine. The grant is revoked
// when the dispatch returns, consumed or not, so it cannot outlive it.

import type { DeferredCallRecord } from "../inbox/types.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager } from "../rbac.js";
import { getApprovalManager } from "../approval-manager.js";
import { unifiedRegistry } from "../tools/registry.js";
import { withoutResultHeader } from "../tools/result-helpers.js";
import { toolMessageStatus } from "./tool-message-carry.js";
import { executeToolCalls } from "./execute-tool.js";

export interface ApprovedCallDeps {
  /** The server's tool catalog. */
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  rbac?: RBACManager;
  threatEngine?: ThreatEngine;
  onEvent?: (event: ServerEvent) => void;
}

/** The tool a stored call names, from the catalog or the registry of tools a
 *  run can load by name; undefined when it was renamed or removed. */
export function resolveApprovedTool(name: string, tools: ToolDefinition[]): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name) ?? unifiedRegistry.get(name);
}

/** Dispatch the approved call once. Returns its status and its text for the
 *  user's inbox. */
export async function dispatchApprovedCall(
  call: DeferredCallRecord,
  itemId: string,
  deps: ApprovedCallDeps,
): Promise<{ status: string; text: string }> {
  const toolMap = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const tool = resolveApprovedTool(call.toolName, deps.tools);
  if (tool) toolMap.set(tool.name, tool);
  const grants = getApprovalManager().callGrants;
  const grantId = grants.grant(call.sessionId || "default", call.toolName, call.args);
  try {
    const msgs = await executeToolCalls(
      [{ id: `inbox-${itemId}`, name: call.toolName, arguments: JSON.stringify(call.args) }],
      toolMap, deps.security, deps.toolPolicy, deps.threatEngine, deps.rbac, call.callerRole,
      call.sessionId, deps.onEvent, undefined, undefined, call.runId, call.opId, call.callContext,
    );
    const toolMsg = msgs.find((m) => m.role === "tool");
    if (!toolMsg) return { status: "error", text: "The call produced no result." };
    const rendered = typeof toolMsg.content === "string" ? toolMsg.content : "";
    // The user reads this, not the model: the header and the model's next-step
    // line go, the user hint and the result stay.
    const text = withoutResultHeader(rendered).split("\n").filter((line) => !line.startsWith("Recovery: ")).join("\n");
    return { status: toolMessageStatus(toolMsg), text };
  } finally {
    grants.revoke(grantId);
  }
}
