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

/** Margin the hang-catcher leaves past a tool's own deadline. */
const BACKSTOP_MARGIN_MS = 10_000;

/**
 * The runner's timeout is a HANG-CATCHER: it abandons the execute promise
 * without stopping the work. When a call carries its own `timeout` (bash kills
 * its child at that deadline and says to use process_start), the tool must hit
 * its deadline first — a caller-set 300s was being cut off at the 120s
 * default. The default case is handled in the timeout table itself
 * (tool-timeout.ts: bash's backstop sits above its own 120s default).
 */
export function backstopMs(configured: number, args: Record<string, unknown>): number {
  if (configured <= 0) return configured; // unbounded tools stay unbounded
  const own = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 0;
  if (own === 0) return configured;
  return Math.max(configured, own + BACKSTOP_MARGIN_MS);
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
  const ms = backstopMs(getToolTimeout(input.toolName), input.args);
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
