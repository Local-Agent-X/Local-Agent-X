import type { ToolCall, ToolResult } from "@arikernel/core";

export interface ToolExecutor {
	readonly toolClass: string;
	execute(toolCall: ToolCall): Promise<ToolResult>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

export function makeResult(
	callId: string,
	success: boolean,
	startTime: number,
	data?: unknown,
	error?: string,
): Omit<ToolResult, "taintLabels"> {
	return {
		callId,
		success,
		data,
		error,
		durationMs: Date.now() - startTime,
	};
}

/**
 * Pre-dispatch gate hook — injected by the host (SAX). When set, every
 * concrete executor calls this at the top of `execute()` before doing any
 * work. The host implements it as an adapter over its shared
 * `assertToolCallAllowed` chain (security → policy → threat → approval),
 * which used to live only on the chat-path. Closes F3 in DRY-AUDIT.md.
 *
 * Host responsibilities:
 *   - Throw on deny (the caller treats throws as denied tool calls).
 *   - No-op or return when not configured (default behavior preserves the
 *     standalone package's "policy already enforced upstream" semantics).
 */
type PreDispatchGate = (toolCall: ToolCall) => Promise<void>;

let preDispatchGate: PreDispatchGate | null = null;

export function setPreDispatchGate(fn: PreDispatchGate | null): void {
	preDispatchGate = fn;
}

export async function runPreDispatchGate(toolCall: ToolCall): Promise<void> {
	if (preDispatchGate) await preDispatchGate(toolCall);
}

/**
 * Unified-policy pre-check hook — injected by the host (SAX) so the
 * AriKernel `Pipeline.intercept` step that evaluates `PolicyEngine.evaluate`
 * also runs the consolidated rule packs (security / default-policy / threat
 * / arikernel) before the typed Capability/Taint engine. Closes the 2C.2
 * follow-up flagged in docs/dry-repair-reports/2C.2.md — pipeline.ts:353
 * now consults the same evaluator that SAX's chat-path consults, while the
 * typed PolicyEngine continues to enforce capability tokens / taint rules
 * on the same call.
 *
 * Host responsibilities:
 *   - Return `{ allowed: true }` on accept.
 *   - Return `{ allowed: false, reason }` on deny — the pipeline turns that
 *     into a `Decision { verdict: "deny", reason }` so audit + run-state
 *     bookkeeping stays consistent with the typed-policy path.
 *   - When unset, the pipeline skips the pre-check (preserves the
 *     standalone package's behavior).
 */
export type UnifiedPolicyPreCheck = (toolCall: ToolCall) => Promise<{ allowed: boolean; reason?: string }>;

let unifiedPolicyPreCheck: UnifiedPolicyPreCheck | null = null;

export function setUnifiedPolicyPreCheck(fn: UnifiedPolicyPreCheck | null): void {
	unifiedPolicyPreCheck = fn;
}

export async function runUnifiedPolicyPreCheck(
	toolCall: ToolCall,
): Promise<{ allowed: boolean; reason?: string }> {
	if (!unifiedPolicyPreCheck) return { allowed: true };
	return unifiedPolicyPreCheck(toolCall);
}
