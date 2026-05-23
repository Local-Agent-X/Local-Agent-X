import type { Principal, ToolCallRequest, ToolResult } from "@arikernel/core";
import { ToolCallDeniedError, now } from "@arikernel/core";
import type { FirewallHooks } from "../hooks.js";
import type { Pipeline } from "../pipeline.js";
import type { SidecarHttpClient } from "../sidecar-proxy.js";

export interface ExecutionContext {
	principal: Principal;
	runId: string;
	pipeline: Pipeline;
	hooks: FirewallHooks;
	sidecarClient?: SidecarHttpClient;
}

export async function execute(
	ctx: ExecutionContext,
	request: ToolCallRequest,
): Promise<ToolResult> {
	// In sidecar mode, bypass the local pipeline entirely. The sidecar is the
	// single authoritative enforcement boundary — it handles policy evaluation,
	// token enforcement, behavioral rules, taint tracking, tool execution, and
	// audit logging. The host fires local hooks for observability only.
	if (ctx.sidecarClient) {
		return executeViaSidecar(ctx, request);
	}

	return ctx.pipeline.intercept(request);
}

/**
 * Execute a tool call through the sidecar thin-client path.
 *
 * NO local policy evaluation, NO local token enforcement, NO local behavioral
 * rules, NO local quarantine gating. The sidecar is authoritative for all of
 * these. Host-side denial counters (deniedActions) and local audit records are
 * intentionally NOT updated here — in sidecar mode the sidecar owns all
 * accounting, audit trails, and run-state tracking.
 */
async function executeViaSidecar(
	ctx: ExecutionContext,
	request: ToolCallRequest,
): Promise<ToolResult> {
	try {
		const result = await ctx.sidecarClient!.execute(request);

		ctx.hooks.onExecute?.(
			{
				id: result.callId,
				runId: ctx.runId,
				sequence: 0,
				timestamp: now(),
				principalId: ctx.principal.id,
				toolClass: request.toolClass,
				action: request.action,
				parameters: request.parameters,
				taintLabels: request.taintLabels ?? [],
				grantId: request.grantId,
			},
			result,
		);

		return result;
	} catch (e) {
		if (e instanceof ToolCallDeniedError) {
			ctx.hooks.onDecision?.(e.toolCall, e.decision);
			throw e;
		}
		throw e;
	}
}
