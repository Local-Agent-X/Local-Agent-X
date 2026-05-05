/**
 * Tool dispatch boundary (PRD §15: "Loop dispatches via tool-executor.ts").
 *
 * The canonical-loop NEVER executes tools itself. It hands a `ToolCall` to a
 * `ToolDispatcher` and treats the result as observability + a `tool_result`
 * canonical message for the next turn.
 *
 * The default dispatcher is a no-op (returns an error result). Production
 * wiring (Issue 09 / Issue 13) injects a dispatcher whose implementation
 * delegates to tool-executor.ts. Tests inject a programmable fake.
 *
 * Boundary: this module has no DB handle, no event-writer, no child_process.
 */
import type { ToolCall } from "./contract-types.js";

export interface ToolDispatchResult {
  toolCallId: string;
  status: "ok" | "error" | "cancelled";
  result: unknown;
  durationMs: number;
}

export interface ToolDispatcher {
  dispatch(call: ToolCall): Promise<ToolDispatchResult>;
}

export class NotConfiguredToolDispatcher implements ToolDispatcher {
  async dispatch(call: ToolCall): Promise<ToolDispatchResult> {
    return {
      toolCallId: call.toolCallId,
      status: "error",
      result: { error: `no tool dispatcher configured for tool '${call.tool}'` },
      durationMs: 0,
    };
  }
}

/** Function-style adapter — wraps a plain async function as a ToolDispatcher. */
export function functionToolDispatcher(
  fn: (call: ToolCall) => Promise<Omit<ToolDispatchResult, "toolCallId" | "durationMs">>,
): ToolDispatcher {
  return {
    async dispatch(call) {
      const start = Date.now();
      const out = await fn(call);
      return {
        toolCallId: call.toolCallId,
        status: out.status,
        result: out.result,
        durationMs: Date.now() - start,
      };
    },
  };
}
