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
