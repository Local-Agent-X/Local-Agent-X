import type { ToolCall } from "@arikernel/core";
import { SAFE_GET_HEADERS, VALUE_INSPECTED_HEADERS } from "@arikernel/tool-executors";
import { isSuspiciousGetExfil, suspiciousHeaderValue } from "../run-state.js";
import { type PipelineContext, checkBehavioralRules, denyQuarantinedAction } from "./context.js";

// Step 1.5b: Pre-execution run-state signals. Track taint, egress, sensitive
// reads and emit security events before policy evaluation. Returning here may
// short-circuit via denyQuarantinedAction when behavioral rules trigger.
export function trackPreExecutionSignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;

	if (toolCall.taintLabels.length > 0) {
		runState.accumulateTaintLabels(toolCall.taintLabels);
		for (const label of toolCall.taintLabels) {
			ctx.persistentTaint?.recordTaintObserved(label.source);
		}
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "taint_observed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			taintSources: toolCall.taintLabels.map((t) => t.source),
		});
		if (checkBehavioralRules(ctx, toolCall)) {
			denyQuarantinedAction(ctx, toolCall, "behavioral rule triggered by tainted input");
		}
	}

	if (toolCall.toolClass === "http") {
		trackHttpSignals(ctx, toolCall);
	}
	if (toolCall.toolClass === "file") {
		trackFileSignals(ctx, toolCall);
	}
}

function trackHttpSignals(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;
	const isWriteEgress = runState.isEgressAction(toolCall.action);
	const httpUrl = String(toolCall.parameters.url ?? "");
	const isGetExfil =
		!isWriteEgress &&
		(toolCall.action === "get" || toolCall.action === "head") &&
		isSuspiciousGetExfil(httpUrl);

	if ((toolCall.action === "get" || toolCall.action === "head") && httpUrl.includes("?")) {
		runState.recordHttpGetEgress(httpUrl);
	}

	// After a sensitive read, treat any GET with query params as potential exfil.
	// This closes the slow-drip gap where small GETs evade isSuspiciousGetExfil thresholds.
	const isSensitiveGetExfil =
		!isWriteEgress &&
		!isGetExfil &&
		(toolCall.action === "get" || toolCall.action === "head") &&
		runState.sensitiveReadObserved &&
		httpUrl.includes("?");

	if (isWriteEgress || isGetExfil || isSensitiveGetExfil) {
		runState.recordEgressAttempt();
		ctx.persistentTaint?.recordEgress(httpUrl);
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "egress_attempt",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: { url: toolCall.parameters.url, getExfil: isGetExfil || undefined },
		});
		if (checkBehavioralRules(ctx, toolCall)) {
			denyQuarantinedAction(
				ctx,
				toolCall,
				isGetExfil
					? "behavioral rule triggered by suspicious GET exfiltration"
					: "behavioral rule triggered by egress attempt",
			);
		}
	}

	if (
		!isWriteEgress &&
		(toolCall.action === "get" || toolCall.action === "head") &&
		runState.sensitiveReadObserved
	) {
		inspectGetHeaders(ctx, toolCall);
	}
}

// After a sensitive read or in a tainted run, custom headers on GET/HEAD are a
// potential exfil vector (secrets smuggled in X-Data, X-Payload, etc.). Only
// standard browser/HTTP headers are permitted. Allowed headers that can carry
// arbitrary values have their values inspected for encoded payloads.
function inspectGetHeaders(ctx: PipelineContext, toolCall: ToolCall): void {
	const runState = ctx.runState;
	if (!runState) return;
	const headers = toolCall.parameters.headers as Record<string, string> | undefined;
	if (!headers) return;

	const customHeaders = Object.keys(headers).filter((h) => {
		const lower = h.toLowerCase();
		return !SAFE_GET_HEADERS.has(lower) && !VALUE_INSPECTED_HEADERS.has(lower);
	});
	if (customHeaders.length > 0) {
		runState.recordEgressAttempt();
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "egress_attempt",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: {
				url: toolCall.parameters.url,
				customHeaders,
				reason: "custom headers on GET/HEAD after sensitive read",
			},
		});
		denyQuarantinedAction(
			ctx,
			toolCall,
			`Custom headers on HTTP ${toolCall.action.toUpperCase()} blocked in security-sensitive context. Non-standard headers [${customHeaders.join(", ")}] can exfiltrate data. Only standard headers are allowed after sensitive reads.`,
		);
	}

	// Both VALUE_INSPECTED_HEADERS and SAFE_GET_HEADERS are checked: SAFE_GET_HEADERS
	// (accept, host, etc.) can carry encoded data in values even though the header
	// names themselves are benign.
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (!VALUE_INSPECTED_HEADERS.has(lower) && !SAFE_GET_HEADERS.has(lower)) continue;
		const reason = suspiciousHeaderValue(lower, value);
		if (reason) {
			runState.recordEgressAttempt();
			runState.pushEvent({
				timestamp: toolCall.timestamp,
				type: "egress_attempt",
				toolClass: toolCall.toolClass,
				action: toolCall.action,
				metadata: {
					url: toolCall.parameters.url,
					suspiciousHeader: name,
					reason,
				},
			});
			denyQuarantinedAction(
				ctx,
				toolCall,
				`Suspicious encoded payload in HTTP header value blocked in security-sensitive context. ${reason}`,
			);
		}
	}
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
	if (checkBehavioralRules(ctx, toolCall)) {
		denyQuarantinedAction(ctx, toolCall, "behavioral rule triggered by sensitive file access");
	}
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
		if (checkBehavioralRules(ctx, toolCall)) {
			denyQuarantinedAction(ctx, toolCall, "behavioral rule triggered by shell command");
		}
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
		if (checkBehavioralRules(ctx, toolCall)) {
			denyQuarantinedAction(ctx, toolCall, "behavioral rule triggered by database operation");
		}
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
		if (checkBehavioralRules(ctx, toolCall)) {
			denyQuarantinedAction(ctx, toolCall, "behavioral rule triggered by HTTP operation");
		}
	}
}
