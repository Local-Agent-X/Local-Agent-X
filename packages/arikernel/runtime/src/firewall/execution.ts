import type { Decision, ToolCall, ToolCallRequest, ToolResult } from "@arikernel/core";
import { ApprovalRequiredError, ToolCallDeniedError } from "@arikernel/core";
import type { Pipeline } from "../pipeline.js";

export interface ExecutionContext {
	pipeline: Pipeline;
}

export async function execute(
	ctx: ExecutionContext,
	request: ToolCallRequest,
): Promise<ToolResult> {
	return ctx.pipeline.intercept(request);
}

/** A call's outcome as a value: allowed with its result, or refused with the
 *  decision that refused it. Only an engine fault is thrown. */
export type Judgement =
	| { allowed: true; result: ToolResult }
	| { allowed: false; decision: Decision; toolCall: ToolCall };

/**
 * The pipeline delivers every refusal (policy, capability token, run rule,
 * restricted mode, an approval nobody granted) by throwing. Telling those
 * apart from a fault is decided here, inside the package whose classes threw
 * them, so a host never has to recognise a deny by an error's name.
 */
export async function judge(ctx: ExecutionContext, request: ToolCallRequest): Promise<Judgement> {
	try {
		return { allowed: true, result: await ctx.pipeline.intercept(request) };
	} catch (e) {
		if (e instanceof ToolCallDeniedError || e instanceof ApprovalRequiredError) {
			return { allowed: false, decision: e.decision, toolCall: e.toolCall };
		}
		throw e;
	}
}
