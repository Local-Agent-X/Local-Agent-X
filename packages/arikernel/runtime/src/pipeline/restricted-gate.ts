import type { Decision, ToolCall } from "@arikernel/core";
import { ToolCallDeniedError, now } from "@arikernel/core";
import { type PipelineContext, logEvent } from "./context.js";

// Step 1.5a: Restricted-mode gating. If the run is quarantined, only safe
// read-only actions pass, and parameterized GETs only up to a small budget
// (none after a sensitive read), so a quarantined run cannot drip data out
// through query strings.
export function enforceRestrictedMode(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState?.restricted) return;

	const isSafeAction = runState.isAllowedInRestrictedMode(toolCall.toolClass, toolCall.action);
	const url = String(toolCall.parameters.url ?? "");

	let isGetBudgetExhausted = false;
	if (isSafeAction && toolCall.toolClass === "http" && (toolCall.action === "get" || toolCall.action === "head")) {
		try {
			if (new URL(url).searchParams.size > 100) isGetBudgetExhausted = true;
		} catch {}
		if (url.includes("?")) isGetBudgetExhausted = runState.recordQuarantineGet();
	}

	if (!isSafeAction || isGetBudgetExhausted) {
		const reason = isGetBudgetExhausted
			? `HTTP GET with query parameters blocked: quarantine GET budget exhausted (${runState.quarantineGetCount} requests). Potential slow-drip exfiltration.`
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
