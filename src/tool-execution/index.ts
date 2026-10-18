// Public surface for the tool-execution pipeline.
// Imported directly by callers (chat-tool-dispatcher, routes/chat, routes/mcp,
// tests) — this index is the public surface.

export { executeToolCalls } from "./execute-tool.js";
export { executeHarnessCommand } from "./harness-exec.js";
export { dispatchApprovedCall, resolveApprovedTool } from "./approved-call.js";
export { latestUserMessageId, markDryRunSession, unmarkDryRunSession } from "./resolve-tool.js";
export { getRiskLevel, buildApprovalContext } from "./approval-context.js";
export { ToolBlocked } from "./errors.js";
