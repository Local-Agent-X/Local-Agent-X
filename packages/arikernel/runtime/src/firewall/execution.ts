import type { ToolCallRequest, ToolResult } from "@arikernel/core";
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
