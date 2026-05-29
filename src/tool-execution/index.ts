// Public surface for the tool-execution pipeline.
// Legacy `src/tool-executor.ts` re-exports from here so existing callers
// don't need to update import paths.

export { executeToolCalls, dispatchSingleToolCall, checkAndCompact, checkAndCompactAsync } from "./execute-tool.js";
export type { UnifiedDispatchCtx } from "./execute-tool.js";
export { markDryRunSession, unmarkDryRunSession } from "./resolve-tool.js";
export { getRiskLevel, buildApprovalContext } from "./approval-context.js";
export { ToolBlocked } from "./errors.js";
