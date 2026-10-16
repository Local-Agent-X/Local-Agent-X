import { getSandboxStatus, SANDBOX_PROOF_PENDING_RETRY } from "../sandbox/index.js";
import { WORKER_CONTEXTS } from "../security/layer/index.js";
import { hasCapability } from "../tool-registry.js";
import { blocked } from "../tools/result-helpers.js";
import type { ToolResult } from "../types.js";
import type { CallContext } from "./context.js";
import { sessionWorkRootOf } from "../workspace/paths.js";

export function unattendedShellBlock(
  toolName: string,
  callContext: CallContext,
  sessionId?: string,
): ToolResult | null {
  if (!hasCapability(toolName, "shell") || callContext === "local") return null;

  const sandbox = getSandboxStatus();
  // A worker run (delegated agent or scheduled job) scoped to its own work root.
  const worker = WORKER_CONTEXTS.has(callContext);
  const scopedRun = worker && !!sessionId && !!sessionWorkRootOf(sessionId);
  const contextAllowed = worker ? sandbox.delegatedShellAllowed || scopedRun : sandbox.apiShellAllowed;
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
