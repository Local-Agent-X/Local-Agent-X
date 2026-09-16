import type { ToolDefinition, ToolResult } from "../types.js";
import { withRetry } from "../auto-retry.js";
import { getRetryContext } from "../retry-context.js";
import { getToolTimeout, withTimeout } from "./tool-timeout.js";
import { isRetryable, retrySignalForToolResult } from "../resilience-policy.js";
import { createRetryCallSnapshot } from "./retry-call.js";
import { createJournaledExecution } from "./journaled-execution.js";
import { currentApprovalWaitMs, runInApprovalWaitScope } from "../approval-wait.js";

export interface ToolRunner {
  /** True when the side-effect journal satisfied this call without executing
   *  it (replay of a completed entry, or its blocked siblings). Decided at
   *  creation — prepareSideEffect runs inside createToolRunner. */
  readonly replayed: boolean;
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
      // One wait scope per attempt: an approval card raised anywhere inside
      // this execute is the user's time, not the tool's, and the timeout
      // excludes it (approval-wait.ts).
      return await runInApprovalWaitScope(async () => {
        const execution = input.tool.execute(args, input.signal);
        return await (ms > 0
          ? withTimeout(execution, ms, input.toolName, currentApprovalWaitMs)
          : execution);
      });
    });
    const retrySignal = journal.replayed ? null : retrySignalForToolResult(result, call.effect);
    if (retrySignal) throw retrySignal;
    return result;
  };
  return {
    replayed: journal.replayed,
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
