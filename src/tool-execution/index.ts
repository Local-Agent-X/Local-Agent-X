// Public surface for the tool-execution pipeline.
// Imported directly by callers (chat-tool-dispatcher, routes/chat, routes/mcp,
// tests) — this index is the public surface.

export { executeToolCalls, dispatchSingleToolCall } from "./execute-tool.js";
export type { UnifiedDispatchCtx } from "./execute-tool.js";
export { markDryRunSession, unmarkDryRunSession } from "./resolve-tool.js";
export { getRiskLevel, buildApprovalContext } from "./approval-context.js";
export { ToolBlocked } from "./errors.js";
