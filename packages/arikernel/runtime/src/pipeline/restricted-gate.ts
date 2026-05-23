import type { Decision, ToolCall } from "@arikernel/core";
import { ToolCallDeniedError, now } from "@arikernel/core";
import { hasEncodedPayload, isSuspiciousGetExfil } from "../run-state.js";
import { type PipelineContext, logEvent } from "./context.js";

// Step 1.5a: Restricted-mode gating. If the run is quarantined, only safe
// read-only actions pass — and even those are blocked when the request shape
// suggests exfiltration (suspicious GETs, parameterized GETs after budget,
// encoded payloads in query params).
export function enforceRestrictedMode(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState?.restricted) return;

	const isSafeAction = runState.isAllowedInRestrictedMode(toolCall.toolClass, toolCall.action);

	// Even safe GET/HEAD is blocked if the URL carries suspicious exfil patterns
	const url = String(toolCall.parameters.url ?? "");
	const isGetExfil = isSafeAction && toolCall.toolClass === "http" && isSuspiciousGetExfil(url);

	// Block GETs with query parameters after a budget is exhausted.
	// After sensitive read, budget is 0 — all parameterized GETs are blocked.
	let isGetBudgetExhausted = false;
	let isEncodedExfil = false;
	if (
		isSafeAction &&
		!isGetExfil &&
		toolCall.toolClass === "http" &&
		(toolCall.action === "get" || toolCall.action === "head")
	) {
		try {
			const parsed = new URL(url);
			if (parsed.searchParams.size > 100) {
				isGetBudgetExhausted = true;
			}
		} catch {}
		if (url.includes("?")) {
			isGetBudgetExhausted = runState.recordQuarantineGet();
		}
		if (!isGetBudgetExhausted && hasEncodedPayload(url)) {
			isEncodedExfil = true;
		}
	}

	if (!isSafeAction || isGetExfil || isGetBudgetExhausted || isEncodedExfil) {
		const reason = isEncodedExfil
			? "HTTP GET with encoded payload blocked in quarantine. Base64/hex data detected in query parameters."
			: isGetBudgetExhausted
				? `HTTP GET with query parameters blocked: quarantine GET budget exhausted (${runState.quarantineGetCount} requests). Potential slow-drip exfiltration.`
				: isGetExfil
					? `Suspicious data exfiltration via GET query parameters blocked in restricted mode. '${toolCall.toolClass}.${toolCall.action}' denied.`
					: `Run entered restricted mode at ${runState.restrictedAt} after ${runState.counters.deniedActions} denied sensitive actions. ` +
						`Only read-only safe actions are allowed. '${toolCall.toolClass}.${toolCall.action}' is blocked.`;
		const decision: Decision = {
			verdict: "deny",
			matchedRule: null,
			reason,
			taintLabels: toolCall.taintLabels,
			timestamp: now(),
		};
		runState.recordDeniedAction();
		logEvent(ctx, toolCall, decision);
		throw new ToolCallDeniedError(toolCall, decision);
	}
}
