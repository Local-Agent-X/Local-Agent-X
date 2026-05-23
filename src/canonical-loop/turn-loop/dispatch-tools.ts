// Tool dispatch for a turn. Walks the model's tool_call_requested list in
// order, dispatches each via the canonical tool-dispatcher boundary, and
// captures the result rows for commitTurn. Cancellation between tools is
// honored so a long parallel-call group doesn't keep marching after the
// user cancels.

import { createHash } from "node:crypto";
import type { CanonicalMessageRole, ToolCallSummary } from "../types.js";
import type { ToolCall } from "../contract-types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import { emit } from "../event-emitter.js";
import { getToolDispatcher } from "../runtime.js";

export interface DispatchedTools {
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
}

export async function dispatchTools(
  opId: string,
  turnIdx: number,
  calls: ToolCall[],
  isCancelled?: () => boolean,
): Promise<DispatchedTools> {
  if (calls.length === 0) return { toolMessages: [], toolSummary: [] };
  const dispatcher = getToolDispatcher(opId);
  const toolMessages: CommitTurnMessage[] = [];
  const toolSummary: ToolCallSummary[] = [];

  for (const call of calls) {
    // Bail before dispatching the next tool if the op was cancelled while a
    // previous tool in this batch was running. Without this, a parallel call
    // group like [self_edit, web_search, web_search, ...] keeps marching after
    // cancel — every subsequent tool fires its own abort error and the worker
    // never reaches the post-dispatch isCancelled check in driveTurn because
    // the for-loop never breaks. Empty toolMessages/toolSummary returned here
    // is fine: driveTurn sees the cancellation at the post-dispatch check
    // and returns cancelled=true without committing the partial turn.
    if (isCancelled?.()) break;
    const argsHash = hashArgs(call.args);
    emit(opId, "tool_started", { turnIdx, tool: call.tool, argsHash });
    const out = await dispatcher.dispatch(call);
    emit(opId, "tool_finished", {
      turnIdx,
      tool: call.tool,
      status: out.status,
      durationMs: out.durationMs,
    });
    toolSummary.push({
      tool: call.tool,
      argsHash,
      resultStatus: out.status,
      durationMs: out.durationMs,
    });
    const role: CanonicalMessageRole = "tool_result";
    toolMessages.push({
      role,
      content: { toolCallId: call.toolCallId, result: out.result, status: out.status },
    });
  }
  return { toolMessages, toolSummary };
}

function hashArgs(args: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 16);
  } catch {
    return "0000000000000000";
  }
}
