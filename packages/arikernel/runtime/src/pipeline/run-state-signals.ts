import type { ToolCall } from "@arikernel/core";
import { type PipelineContext, checkBehavioralRules, denyByRule } from "./context.js";

// Step 1.5b: Pre-execution run-state signals. Track taint, egress, sensitive
// reads and emit security events before policy evaluation. A call that
// completes a behavioral rule's pattern is refused here (denyByRule).
export function trackPreExecutionSignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;

	if (toolCall.taintLabels.length > 0) {
		runState.accumulateTaintLabels(toolCall.taintLabels);
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "taint_observed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			taintSources: toolCall.taintLabels.map((t) => t.source),
		});
	}

	if (toolCall.toolClass === "http") {
		trackHttpSignals(ctx, toolCall);
	}
	if (toolCall.toolClass === "file") {
		trackFileSignals(ctx, toolCall);
	}
}

// A write is egress, and feeds the behavioral rules. Whether its bytes may
// leave is the host's judgement on the bytes (Local Agent X's egress judge,
// at dispatch and at send); the kernel no longer guesses it from the shape of
// a URL or a header value.
function trackHttpSignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;
	// Lowercase defensively: ingest canonicalizes the action, but the egress
	// check compares against lowercase literals.
	if (!runState.isEgressAction(toolCall.action.toLowerCase())) return;
	runState.recordEgressAttempt();
	runState.pushEvent({
		timestamp: toolCall.timestamp,
		type: "egress_attempt",
		toolClass: toolCall.toolClass,
		action: toolCall.action,
		metadata: { url: toolCall.parameters.url },
	});
	const denial = checkBehavioralRules(ctx, toolCall);
	if (denial) denyByRule(ctx, toolCall, denial);
}

function trackFileSignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;
	const path = String(toolCall.parameters.path ?? "");
	if (!runState.isSensitivePath(path)) return;

	runState.recordSensitiveFileAttempt();
	runState.pushEvent({
		timestamp: toolCall.timestamp,
		type: "sensitive_read_attempt",
		toolClass: toolCall.toolClass,
		action: toolCall.action,
		metadata: { path },
	});
	const denial = checkBehavioralRules(ctx, toolCall);
	if (denial) denyByRule(ctx, toolCall, denial);
}

// Step 4.5: Emit metadata for behavioral rules AFTER policy allowed the action.
// This prevents false quarantines from denied actions.
export function emitPostPolicySignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;

	if (toolCall.toolClass === "shell") {
		const command = String(toolCall.parameters.command ?? "");
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "tool_call_allowed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: { commandLength: command.length },
		});
		const denial = checkBehavioralRules(ctx, toolCall);
		if (denial) denyByRule(ctx, toolCall, denial);
	}
	if (toolCall.toolClass === "database") {
		const table = String(toolCall.parameters.table ?? "");
		const query = String(toolCall.parameters.query ?? "");
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "tool_call_allowed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: { table, query },
		});
		const denial = checkBehavioralRules(ctx, toolCall);
		if (denial) denyByRule(ctx, toolCall, denial);
	}
	if (toolCall.toolClass === "http") {
		const url = String(toolCall.parameters.url ?? "");
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "tool_call_allowed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: { url },
		});
		const denial = checkBehavioralRules(ctx, toolCall);
		if (denial) denyByRule(ctx, toolCall, denial);
	}
}
