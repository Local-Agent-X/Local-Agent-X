import { getSandboxStatus } from "../sandbox/index.js";
import { hasCapability } from "../tool-registry.js";
import { blocked } from "../tools/result-helpers.js";
import type { ToolResult } from "../types.js";
import type { CallContext } from "./context.js";

export function unattendedShellBlock(
  toolName: string,
  callContext: CallContext,
): ToolResult | null {
  if (!hasCapability(toolName, "shell") || callContext === "local") return null;

  const sandbox = getSandboxStatus();
  const contextAllowed = callContext === "cron"
    ? sandbox.cronShellAllowed
    : callContext === "delegated"
      ? sandbox.delegatedShellAllowed
      : sandbox.apiShellAllowed;
  if (contextAllowed) return null;

  const reason = callContext === "cron"
    ? "Shell execution is categorically disabled for cron runs, regardless of sandbox mode or host acknowledgement."
    : `The selected sandbox mode is "${sandbox.selectedMode}" but the effective mode is "host". ` +
      `A user must explicitly acknowledge unconfined unattended shell execution in Settings > Security before this ${callContext} run can use shell-exec tools.`;
  return blocked(
    `BLOCKED (unattended): ${toolName} cannot execute in this ${callContext} context. ${reason}`,
    {
      layer: "sandbox",
      callContext,
      selectedMode: sandbox.selectedMode,
      effectiveMode: sandbox.effectiveMode,
      recovery: callContext === "cron"
        ? "Run the shell step interactively or through a delegated/API run whose effective sandbox is confined or explicitly acknowledged."
        : "Ask the user to review and acknowledge the effective sandbox status in Settings > Security.",
    },
  );
}
