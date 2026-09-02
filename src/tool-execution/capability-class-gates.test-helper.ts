// Shared fixture for the capability-class gate suites
// (capability-class-gates.test.ts + capability-class-egress-scan.test.ts):
// a minimal ToolCallContext for driving the egress/lineage/canary gates
// directly. Not a test file — the `.test-helper.ts` suffix keeps it out of
// the vitest include glob (same convention as symlink-capabilities).

import type { ToolCallContext } from "./context.js";

export function makeCtx(name: string, args: Record<string, unknown>, sessionId: string): ToolCallContext {
  return {
    tc: { id: "1", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: undefined as never,
    sessionId,
    callContext: "local",
    args,
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  } as ToolCallContext;
}
