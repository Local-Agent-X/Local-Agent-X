import { getSandboxStatus, SANDBOX_PROOF_PENDING_RETRY } from "../sandbox/index.js";
import { WORKER_CONTEXTS } from "../security/layer/index.js";
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
  // A worker run (delegated agent or scheduled job) runs shell only inside a
  // confined sandbox or on a host the user acknowledged; its work root anchors
  // the command, it does not contain it.
  const contextAllowed = WORKER_CONTEXTS.has(callContext) ? sandbox.delegatedShellAllowed : sandbox.apiShellAllowed;
  if (contextAllowed) return null;

  // Not a host to acknowledge yet: the Windows cage is still proving its fence,
  // and its answer lands within seconds.
  if (sandbox.proofPending) {
    return blocked(
      `BLOCKED (unattended): ${toolName} cannot execute yet in this ${callContext} context. ${SANDBOX_PROOF_PENDING_RETRY}`,
      {
        layer: "sandbox",
        callContext,
        selectedMode: sandbox.selectedMode,
        effectiveMode: sandbox.effectiveMode,
        proofPending: true,
        recovery: "Retry this call in a few seconds, once the cage check has finished.",
      },
    );
  }

  const reason = `The selected sandbox mode is "${sandbox.selectedMode}" but the effective mode is "host". ` +
    `A user must explicitly acknowledge unconfined unattended shell execution in Settings > Security before this ${callContext} run can use shell-exec tools.`;
  return blocked(
    `BLOCKED (unattended): ${toolName} cannot execute in this ${callContext} context. ${reason}`,
    {
      layer: "sandbox",
      callContext,
      selectedMode: sandbox.selectedMode,
      effectiveMode: sandbox.effectiveMode,
      recovery: "Ask the user to review and acknowledge the effective sandbox status in Settings > Security.",
    },
  );
}
