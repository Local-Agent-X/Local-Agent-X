import type { ToolDefinition, ToolResult } from "../types.js";
import { withRetry } from "../auto-retry.js";
import { getRetryContext } from "../retry-context.js";
import { getToolTimeout, withTimeout } from "../tool-timeout.js";
import { isRetryable, retrySignalForToolResult } from "../resilience-policy.js";
import { createRetryCallSnapshot } from "./retry-call.js";
import { createJournaledExecution } from "./journaled-execution.js";

export interface ToolRunner {
  run(): Promise<ToolResult>;
  reconcile(error: unknown): ToolResult | null;
  complete(result: ToolResult): void;
}

/** Execute one pinned call with timeout, effect-aware retry, and journaling. */
export function createToolRunner(input: {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  operationId?: string;
  toolCallId: string;
  toolName: string;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
}): ToolRunner {
  const call = createRetryCallSnapshot(input.tool, input.args);
  const journal = createJournaledExecution({
    operationId: input.operationId,
    toolCallId: input.toolCallId,
    tool: input.toolName,
    args: call.args as Record<string, unknown>,
    effect: call.effect,
  });
  const ms = getToolTimeout(input.toolName);
  const runOnce = async () => {
    const result = await journal.run(async () => {
      const args = call.freshArgs();
      args._onProgress = input.onProgress;
      const execution = input.tool.execute(args, input.signal);
      return await (ms > 0 ? withTimeout(execution, ms, input.toolName) : execution);
    });
    const retrySignal = journal.replayed ? null : retrySignalForToolResult(result, call.effect);
    if (retrySignal) throw retrySignal;
    return result;
  };
  return {
    run: () => call.retryable
      ? withRetry(runOnce, {
          maxRetries: 2,
          baseDelayMs: 500,
          maxDelayMs: 4000,
          shouldRetry: (error, attempt) => isRetryable(error, { effect: call.effect, attempt }),
          ctx: getRetryContext(input.sessionId),
          layer: "L1-tool",
        })
      : runOnce(),
    reconcile: error => journal.reconcile(error),
    complete: result => journal.complete(result),
  };
}
