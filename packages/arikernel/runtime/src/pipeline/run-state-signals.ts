import type { ToolCall } from "@arikernel/core";
import { SAFE_GET_HEADERS, VALUE_INSPECTED_HEADERS } from "@arikernel/tool-executors";
import type { RunStateTracker } from "../run-state.js";
import { isSuspiciousGetExfil, pathDripEncodedBytes, suspiciousHeaderValue } from "../run-state.js";
import { type PipelineContext, checkBehavioralRules, denyQuarantinedAction } from "./context.js";

/** Taint sources that, like a sensitive read, warrant treating GETs as egress. */
const EGRESS_TAINT_SOURCES: ReadonlySet<string> = new Set(["web", "rag", "email"]);

/** Whether the run carries web/rag/email taint (mirrors the behavioral-rule check). */
function hasEgressTaint(runState: RunStateTracker): boolean {
	if (!runState.tainted) return false;
	for (const source of runState.taintSources) {
		if (EGRESS_TAINT_SOURCES.has(source)) return true;
	}
	return false;
}

/** Whether a URL targets a host that is NOT on the egress allowlist. */
function isNonAllowlistedHost(runState: RunStateTracker, url: string): boolean {
	try {
		return !runState.isAllowlistedHost(new URL(url).hostname);
	} catch {
		// Unparseable URL: not a clean allowlisted GET — leave to downstream policy.
		return false;
	}
}

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
	const isGet = toolCall.action === "get" || toolCall.action === "head";
	const isGetExfil = !isWriteEgress && isGet && isSuspiciousGetExfil(httpUrl);

	// On a security-sensitive run (sensitive read observed, or web/rag/email
	// taint), a GET/HEAD to a non-allowlisted host that CARRIES A PAYLOAD is
	// reclassified as outbound egress. Previously "carries a payload" meant only
	// a query string ("?"), which let H11 drip a secret through URL PATH SEGMENTS
	// with no query. We now also feed the encoded path bytes into the per-host/
	// per-run drip budget and treat any present encoded path bytes as a payload.
	// A plain content GET (no query, no encoded path) stays allowed so normal
	// page fetches after a sensitive read are not over-blocked.
	// When the run is already restricted, enforceRestrictedMode (Step 1.5a) owns
	// the path-drip accounting for this request and has already returned/thrown,
	// so we skip it here to avoid double-counting the same encoded path bytes.
	const sensitiveContext = runState.sensitiveReadObserved || hasEgressTaint(runState);
	let isPathDripExfil = false;
	let hasEncodedPathPayload = false;
	if (!isWriteEgress && isGet && sensitiveContext && !runState.restricted) {
		try {
			const hostname = new URL(httpUrl).hostname;
			if (!runState.isAllowlistedHost(hostname)) {
				hasEncodedPathPayload = pathDripEncodedBytes(httpUrl) > 0;
				isPathDripExfil = runState.recordEncodedPathEgress(httpUrl);
			}
		} catch {
			/* unparseable URL — leave to downstream policy */
		}
	}

	if (isGet && httpUrl.includes("?")) {
		runState.recordHttpGetEgress(httpUrl);
	}

	// After a sensitive read (or in a tainted run), a GET/HEAD to a non-
	// allowlisted host that carries a payload — query string OR encoded path
	// segments — is reclassified as an egress_attempt so Rule 3 can fire. This
	// closes the slow-drip gap where small path-segment GETs evaded both the
	// isSuspiciousGetExfil thresholds and the "?"-keyed query check.
	const isSensitiveGetExfil =
		!isWriteEgress &&
		!isGetExfil &&
		isGet &&
		sensitiveContext &&
		isNonAllowlistedHost(runState, httpUrl) &&
		(httpUrl.includes("?") || hasEncodedPathPayload);

	if (isWriteEgress || isGetExfil || isSensitiveGetExfil || isPathDripExfil) {
		runState.recordEgressAttempt();
		ctx.persistentTaint?.recordEgress(httpUrl);
		runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "egress_attempt",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			metadata: {
				url: toolCall.parameters.url,
				getExfil: isGetExfil || undefined,
				pathDrip: isPathDripExfil || undefined,
			},
		});
		const quarantined = checkBehavioralRules(ctx, toolCall);
		if (quarantined) {
			denyQuarantinedAction(
				ctx,
				toolCall,
				isGetExfil
					? "behavioral rule triggered by suspicious GET exfiltration"
					: "behavioral rule triggered by egress attempt",
			);
		}
		// The path-drip budget is a standalone backstop: once a tainted/
		// sensitive-read run has dripped more than the per-request or per-run
		// encoded-path budget to a non-allowlisted host, deny even if no
		// behavioral sequence rule matched this step. This is the slow-drip
		// defense that the per-host accounting now actually enforces.
		if (isPathDripExfil) {
			denyQuarantinedAction(
				ctx,
				toolCall,
				"encoded-path drip budget exceeded to non-allowlisted host after sensitive read",
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
