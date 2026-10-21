import { getSandboxStatus, SANDBOX_PROOF_PENDING_RETRY, type SandboxStatus } from "../sandbox/index.js";
import { WORKER_CONTEXTS } from "../security/layer/index.js";
import { hasCapability } from "../tool-registry.js";
import { blocked } from "../tools/result-helpers.js";
import type { ToolResult } from "../types.js";
import type { CallContext } from "./context.js";

/** Whether a run in `callContext` may use the shell at all: an attended run
 *  always; a worker run (delegated agent or scheduled job) or an API run only
 *  inside a confined sandbox or on a host the user acknowledged — its work
 *  root anchors the command, it does not contain it. The one definition of
 *  "shell allowed here": the gate below refuses on it, and the spawn guard
 *  (agents/spawn-guard.ts) judges a role's edit capability for the run it
 *  will be in by it. */
export function shellAllowedInContext(callContext: CallContext, sandbox: SandboxStatus = getSandboxStatus()): boolean {
  if (callContext === "local") return true;
  return WORKER_CONTEXTS.has(callContext) ? sandbox.delegatedShellAllowed : sandbox.apiShellAllowed;
}

const hostFallbackNoticed = new Set<string>();

/**
 * The notice an ATTENDED shell call carries the first time in a session it
 * runs on a host the cage fell back from — guarded was chosen, the cage is
 * unusable, and nobody has acknowledged running without it. Host mode was a
 * state the agent fell into silently: a Settings badge and nothing in the
 * chat (red team round 2, I-H2). The call still runs — the user is present,
 * and refusing it on a dev box with no cage would stop real work for a
 * one-time click — but the chat now says so, once, and the log says why.
 * Null for a confined cage, a host the user chose or acknowledged, a cage
 * still proving itself, and every call after the first.
 */
export function attendedHostFallbackNotice(
  sessionId: string,
  toolName: string,
  callContext: CallContext,
  sandbox: SandboxStatus = getSandboxStatus(),
): string | null {
  if (callContext !== "local" || !hasCapability(toolName, "shell")) return null;
  if (sandbox.confined || sandbox.proofPending || sandbox.unconfinedHostAcknowledged || sandbox.selectedMode === "host") return null;
  if (hostFallbackNoticed.has(sessionId)) return null;
  hostFallbackNoticed.add(sessionId);
  return `Shell is running UNCONFINED: ${sandbox.fallbackReason ?? "the selected sandbox is unavailable on this host."} ` +
    "Commands run with your full user rights. Restore the cage, or acknowledge running without it, in Settings > Security.";
}

/** Test seam: forget which sessions were told. */
export function _resetHostFallbackNoticesForTests(): void {
  hostFallbackNoticed.clear();
}

export function unattendedShellBlock(
  toolName: string,
  callContext: CallContext,
): ToolResult | null {
  if (!hasCapability(toolName, "shell") || callContext === "local") return null;

  const sandbox = getSandboxStatus();
  if (shellAllowedInContext(callContext, sandbox)) return null;

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
