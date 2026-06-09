import type { ToolCall } from "@arikernel/core";

/**
 * Module-level dispatch gate installed by the host application.
 *
 * `preDispatchGate` is null by default so the package stays usable outside a
 * host that wires it: throw to deny. The host wires its own security /
 * approval / tool-policy chain here (closes F3 from DRY-AUDIT.md).
 *
 * Each concrete executor calls `runPreDispatchGate(toolCall)` as the first
 * line of `execute()`. The gate throws → the executor body never runs →
 * the caller sees the rejection.
 */

type PreDispatchGate = (toolCall: ToolCall) => Promise<void>;

let preDispatchGate: PreDispatchGate | null = null;

export function setPreDispatchGate(fn: PreDispatchGate | null): void {
  preDispatchGate = fn;
}

export async function runPreDispatchGate(toolCall: ToolCall): Promise<void> {
  if (preDispatchGate) await preDispatchGate(toolCall);
}
