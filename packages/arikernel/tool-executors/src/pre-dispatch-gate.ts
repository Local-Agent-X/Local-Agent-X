import type { ToolCall } from "@arikernel/core";

/**
 * Module-level dispatch gates installed by the host application.
 *
 * Two independent hooks, both null by default so the package stays usable
 * outside a host that wires them:
 *
 *   - `preDispatchGate`: throw to deny. Host wires its own security /
 *     approval / tool-policy chain here (closes F3 from DRY-AUDIT.md).
 *   - `unifiedPolicyPreCheck`: return `{ allowed: false, reason }` to deny.
 *     Used by the kernel pipeline to consult the host's rule packs in
 *     series with its typed PolicyEngine (closes the 2C.2 follow-up).
 *
 * Each concrete executor calls `runPreDispatchGate(toolCall)` as the first
 * line of `execute()`. The gate throws → the executor body never runs →
 * the caller sees the rejection.
 */

type PreDispatchGate = (toolCall: ToolCall) => Promise<void>;
type UnifiedPolicyPreCheck = (
  toolCall: ToolCall,
) => Promise<{ allowed: boolean; reason?: string }>;

let preDispatchGate: PreDispatchGate | null = null;
let unifiedPolicyPreCheck: UnifiedPolicyPreCheck | null = null;

export function setPreDispatchGate(fn: PreDispatchGate | null): void {
  preDispatchGate = fn;
}

export async function runPreDispatchGate(toolCall: ToolCall): Promise<void> {
  if (preDispatchGate) await preDispatchGate(toolCall);
}

export function setUnifiedPolicyPreCheck(
  fn: UnifiedPolicyPreCheck | null,
): void {
  unifiedPolicyPreCheck = fn;
}

export async function runUnifiedPolicyPreCheck(
  toolCall: ToolCall,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!unifiedPolicyPreCheck) return { allowed: true };
  return unifiedPolicyPreCheck(toolCall);
}
