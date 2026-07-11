/**
 * Tool dispatch boundary (PRD §15: "Loop dispatches via tool-execution/").
 *
 * The canonical-loop NEVER executes tools itself. It hands a `ToolCall` to a
 * `ToolDispatcher` and treats the result as observability + a `tool_result`
 * canonical message for the next turn.
 *
 * The default dispatcher is a no-op (returns an error result). Production
 * wiring (Issue 09 / Issue 13) injects a dispatcher whose implementation
 * delegates to tool-execution/. Tests inject a programmable fake.
 *
 * Boundary: this module has no DB handle, no event-writer, no child_process.
 */
import type { ToolCall } from "./contract-types.js";
import type { ToolDispatchStatus } from "./types.js";
import type { ToolResultStatus } from "../types.js";

export interface ToolDispatchResult {
  toolCallId: string;
  status: ToolDispatchStatus;
  result: unknown;
  durationMs: number;
}

/**
 * Envelope → dispatch-boundary status. The only collapse the boundary makes:
 * `running` → "ok", because the START succeeded and the work continues async
 * (committedWork proof must not change). Every failure flavor (error, blocked,
 * declined, timeout) passes through so the ledger / telemetry / checkpoints
 * can tell a policy block from a timeout from a user decline.
 */
export function envelopeStatusToDispatchStatus(status: ToolResultStatus): ToolDispatchStatus {
  return status === "running" ? "ok" : status;
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
