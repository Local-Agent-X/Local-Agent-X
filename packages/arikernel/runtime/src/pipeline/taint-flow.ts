import type { TaintLabel, ToolCall, ToolResult } from "@arikernel/core";
import { type PipelineContext, checkBehavioralRules } from "./context.js";

// Step 2: Collect input taint — merge tool-call labels with kernel-maintained
// run-level taint so taint propagates even when a tool or agent omits taintLabels.
export function collectInputTaints(ctx: PipelineContext, toolCall: ToolCall): TaintLabel[] {
	let inputTaints = ctx.taintTracker.collectInputTaints(toolCall);
	if (ctx.runState?.tainted) {
		const runLabels = ctx.runState.accumulatedTaintLabels as TaintLabel[];
		if (runLabels.length > 0) {
			inputTaints = ctx.taintTracker.merge(inputTaints, [...runLabels]);
		}
	}
	return inputTaints;
}

// Steps 5.5 + 6 + 6.1: Derive output taint from content scanning, merge with
// executor auto-taints and propagated input taints, then re-merge run-level
// labels so tools cannot silently clear taint.
export function propagateOutputTaint(
	ctx: PipelineContext,
	toolCall: ToolCall,
	result: ToolResult,
	inputTaints: TaintLabel[],
): void {
	const contentTaints = ctx.taintTracker.scanOutput(result.data, toolCall.id);
	const autoTaints = result.taintLabels;
	const propagated = ctx.taintTracker.propagate(inputTaints, toolCall.id);
	result.taintLabels = ctx.taintTracker.merge(autoTaints, contentTaints, propagated);

	if (ctx.runState?.tainted) {
		const runLabels = ctx.runState.accumulatedTaintLabels as TaintLabel[];
		result.taintLabels = ctx.taintTracker.merge(result.taintLabels, [...runLabels]);
	}
}

// Step 6.2: Accumulate result taint labels into run-level state and emit
// taint_observed for output sources that were not present in the input request.
export function accumulateOutputTaint(
	ctx: PipelineContext,
	toolCall: ToolCall,
	result: ToolResult,
): void {
	if (!ctx.runState || result.taintLabels.length === 0) return;

	ctx.runState.accumulateTaintLabels(result.taintLabels);

	// Emit taint_observed whenever output contains taint sources NOT already
	// present in the input request's taintLabels. This ensures:
	// - New taint from content scanning is always visible to behavioral rules
	// - New taint from executor auto-tainting is always visible
	// - Already-tainted follow-on requests still emit events for NEW sources
	// - Duplicate events are avoided for sources already reported via input taint
	const inputSources = new Set(toolCall.taintLabels.map((t) => t.source));
	const newOutputSources = [...new Set(result.taintLabels.map((t) => t.source))].filter(
		(s) => !inputSources.has(s),
	);
	if (newOutputSources.length > 0) {
		ctx.runState.pushEvent({
			timestamp: toolCall.timestamp,
			type: "taint_observed",
			toolClass: toolCall.toolClass,
			action: toolCall.action,
			taintSources: newOutputSources,
		});
		checkBehavioralRules(ctx, toolCall);
	}
}

// Step 6.5: Push tool_call_allowed event for behavioral tracking and confirm
// sensitive file read only AFTER policy allowed and execution succeeded.
//
// The sticky sensitiveReadObserved flag is set here (not at attempt time) to
// prevent framing attacks where an adversary triggers denied sensitive reads
// to set the sticky flag and contaminate cross-principal shared stores.
// Gate on: toolClass=file, action=read, result.success=true. file.write on a
// sensitive path must NOT set the read-sticky flag. Allowed-but-failed reads
// (e.g. ENOENT) must NOT set it either.
export function recordExecutionOutcome(
	ctx: PipelineContext,
	toolCall: ToolCall,
	result: ToolResult,
): void {
	const runState = ctx.runState;
	if (!runState) return;

	runState.pushEvent({
		timestamp: toolCall.timestamp,
		type: "tool_call_allowed",
		toolClass: toolCall.toolClass,
		action: toolCall.action,
		verdict: "allow",
	});

	if (toolCall.toolClass === "file" && toolCall.action === "read" && result.success) {
		const path = String(toolCall.parameters.path ?? "");
		if (runState.isSensitivePath(path)) {
			runState.confirmSensitiveFileRead();
			ctx.persistentTaint?.recordSensitiveRead(path);
		}
	}

	// Post-execution quarantine check — result is already produced but future
	// actions will be blocked. We don't deny the current result since it already
	// executed, but quarantine is now active.
	checkBehavioralRules(ctx, toolCall);
}
