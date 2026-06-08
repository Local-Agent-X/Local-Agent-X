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
	let isPathDripExfil = false;
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
		// De-"?"-keyed path-drip backstop: a path-segment GET to a non-allowlisted
		// host accumulates encoded path bytes against the per-host/per-run budget
		// even with NO query string. This mirrors trackHttpSignals so a quarantined
		// run cannot keep dripping a secret through path segments (H11). After a
		// sensitive read the tolerance drops to zero (strict), exactly like the
		// query-GET budget=0 rule — any encoded path byte to a non-allowlisted
		// host is blocked.
		if (
			!isGetBudgetExhausted &&
			!isEncodedExfil &&
			runState.recordEncodedPathEgress(url, runState.sensitiveReadObserved)
		) {
			isPathDripExfil = true;
		}
	}

	if (!isSafeAction || isGetExfil || isGetBudgetExhausted || isEncodedExfil || isPathDripExfil) {
		const reason = isEncodedExfil
			? "HTTP GET with encoded payload blocked in quarantine. Base64/hex data detected in query parameters."
			: isPathDripExfil
				? "HTTP GET with encoded path segments blocked in quarantine. Encoded-path drip budget exceeded for non-allowlisted host. Potential slow-drip exfiltration."
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
