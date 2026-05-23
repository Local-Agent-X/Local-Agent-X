/**
 * Context Manager — Token tracking + auto-compaction
 *
 * Tracks token usage across the conversation and auto-compacts
 * when context gets full. Preserves current task state, todo lists,
 * and recent messages so the agent doesn't lose track mid-work.
 *
 * Thresholds:
 * - 70%: UI warning ("context getting full")
 * - 85%: Queue compact for next natural break
 * - 95%: Force compact now, keep working
 * - 100%: Emergency compact + retry
 */

export { estimateTokens, messageTokens, totalTokens } from "./context-manager/token-estimation.js";
export { getContextStatus, type ContextStatus } from "./context-manager/status.js";
export { isContextOverflowError } from "./context-manager/overflow-detection.js";
export { buildCompactionPrompt, forceCompact } from "./context-manager/compaction-prompt.js";
export { compactIfNeeded, compactIfNeededWithLLM } from "./context-manager/compaction.js";
