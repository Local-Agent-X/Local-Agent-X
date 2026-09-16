import type { ToolDefinition, ToolResult } from "../types.js";
import { withRetry } from "../auto-retry.js";
import { getRetryContext } from "../retry-context.js";
import { getToolTimeout, withTimeout } from "./tool-timeout.js";
import { isRetryable, retrySignalForToolResult } from "../resilience-policy.js";
import { createRetryCallSnapshot } from "./retry-call.js";
import { createJournaledExecution } from "./journaled-execution.js";
import { approvalWaitMsFor, clearApprovalWait } from "../approval-manager.js";

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
      const execution = input.tool.execute(args, input.signal);
      // An approval card raised inside this execute is the user's time, not the
      // tool's — the runner's budget excludes it (approval-manager.ts).
      return await (ms > 0
        ? withTimeout(execution, ms, input.toolName, () => approvalWaitMsFor(input.toolCallId))
        : execution);
    });
    const retrySignal = journal.replayed ? null : retrySignalForToolResult(result, call.effect);
    if (retrySignal) throw retrySignal;
    return result;
  };
  // The banked approval wait belongs to THIS call; drop it when the call is
  // done so the map can't grow for the life of the process.
  const runAndRelease = async (): Promise<ToolResult> => {
    try { return await runOnce(); }
    finally { clearApprovalWait(input.toolCallId); }
  };
  return {
    replayed: journal.replayed,
    run: () => call.retryable
      ? withRetry(runAndRelease, {
          maxRetries: 2,
          baseDelayMs: 500,
          maxDelayMs: 4000,
          shouldRetry: (error, attempt) => isRetryable(error, { effect: call.effect, attempt }),
          ctx: getRetryContext(input.sessionId),
          layer: "L1-tool",
        })
      : runAndRelease(),
    reconcile: error => journal.reconcile(error),
    complete: result => journal.complete(result),
  };
}
