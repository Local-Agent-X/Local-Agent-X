/**
 * Context Manager — the sole token-budget + compaction authority.
 *
 * Owns token estimation, context-window math, the fullness verdict, the LLM
 * summarizer, and every compaction/truncation POLICY value (trigger bands,
 * keep counts, digest budgets — see compaction-policy.ts, which also documents
 * what deliberately stays lane-local at the two consuming sites:
 * canonical-loop/turn-loop/compact-history.ts and providers/sanitize.ts).
 */

export { estimateTokens, messageTokens, totalTokens } from "./token-estimation.js";
export { getContextStatus, type ContextStatus } from "./status.js";
export {
	compactionTriggersFor,
	turnCompactionKeepLast,
	chatHistoryMaxKeep,
	DEFAULT_TRIGGERS,
	CODEX_TRIGGERS,
	TURN_KEEP_TIERS,
	CHAT_KEEP,
	CHAT_DIGEST_BUDGETS,
	type CompactionTriggers,
} from "./compaction-policy.js";
export { effectiveContextWindow, isAnthropicModel, type AnthropicTransport } from "./effective-window.js";
export { resolveAnthropicTransport } from "./resolve-transport.js";
export { summarizeOldMessages, COMPACTION_SYSTEM_PROMPT } from "./compaction.js";
