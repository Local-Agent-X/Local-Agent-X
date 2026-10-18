import type { SecurityLayer } from "../security/index.js";
import type { ToolDefinition } from "../types.js";
import { shellCommandOf } from "../tool-registry.js";
import { withoutInternalArgs } from "./internal-args.js";

export function getRiskLevel(_toolName: string, _args: Record<string, unknown>, _security?: SecurityLayer): "low" | "medium" | "high" {
  return "low";
}

/** One line saying what this call does, for the approval card and tool_start:
 *  a shell command as the command (whichever tool runs it — its row's
 *  shellCommand), else the tool's own describeCall, else its name and args. */
export function buildApprovalContext(tool: ToolDefinition | undefined, toolName: string, args: Record<string, unknown>): string {
  const command = shellCommandOf(toolName, args);
  if (command !== undefined) return `Run command: "${command.slice(0, 150)}"`;
  return tool?.describeCall?.(args) ?? `${toolName}: ${JSON.stringify(withoutInternalArgs(args)).slice(0, 80)}`;
}
