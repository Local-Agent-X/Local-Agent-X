/**
 * turn_loop — the inner per-turn driver (PRD §5 / §15).
 *
 * One driveTurn call assembles input from history, hands it to the adapter,
 * forwards stream chunks to the bus, captures finalized messages and
 * tool_call_requested adapter_reports, dispatches tool calls via the
 * canonical tool-dispatcher boundary, then hands all of it to commitTurn
 * for the atomic post-turn write.
 *
 * Boundary rules:
 *   - The loop never executes tools itself — every tool round-trip goes
 *     through `getToolDispatcher().dispatch(call)`.
 *   - The loop never writes `op_events` directly — every event goes through
 *     `emit()`.
 *   - The adapter never writes anything; it only emits adapter_report items
 *     through the report callback.
 */
import { createHash } from "node:crypto";
import type { Adapter, AdapterReport, TurnInput } from "./adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "./contract-types.js";
import type {
  CanonicalMessageRole,
  ProviderStateEnvelope,
  ToolCallSummary,
} from "./types.js";
import { readLatestOpTurn, readOpMessages } from "./store.js";
import { emit, publishStreamChunk } from "./event-emitter.js";
import { commitTurn, type CommitTurnMessage } from "./checkpoint.js";
import { getToolDispatcher } from "./runtime.js";
import type { Op } from "../workers/types.js";

export interface DriveTurnResult {
  terminalReason: "done" | "error" | null;
  toolCount: number;
  messageCount: number;
}

export async function driveTurn(op: Op, adapter: Adapter, turnIdx: number): Promise<DriveTurnResult> {
  emit(op.id, "turn_started", { turnIdx });

  const input = buildTurnInput(op, turnIdx);

  const finalized: CanonicalMessage[] = [];
  const toolCalls: ToolCall[] = [];
  let adapterError: { code: string; message: string } | null = null;

  const result = await adapter.runTurn(input, (r: AdapterReport) => {
    if (r.kind === "stream_chunk") {
      publishStreamChunk(op.id, r.body);
      return;
    }
    if (r.kind === "message_finalized") {
      finalized.push(r.message);
      return;
    }
    if (r.kind === "tool_call_requested") {
      toolCalls.push(r.call);
      return;
    }
    if (r.kind === "error") {
      adapterError = { code: r.code, message: r.message };
      emit(op.id, "error", { code: r.code, message: r.message, retryable: r.retryable });
    }
  });

  const { toolMessages, toolSummary } = await dispatchTools(op.id, turnIdx, toolCalls);

  const allMessages: CommitTurnMessage[] = [];
  for (const m of finalized) {
    allMessages.push({ messageId: m.messageId, role: m.role, content: m.content });
  }
  for (const tm of toolMessages) allMessages.push(tm);

  const providerState: ProviderStateEnvelope = result.providerState;
  const terminalReason: "done" | "error" | null =
    result.terminalReason ?? (adapterError ? "error" : null);

  commitTurn({
    op,
    turnIdx,
    providerState,
    messages: allMessages,
    toolCallSummary: toolSummary,
    terminalReason,
  });

  return { terminalReason, toolCount: toolSummary.length, messageCount: allMessages.length };
}

function buildTurnInput(op: Op, turnIdx: number): TurnInput {
  const history = readOpMessages(op.id);
  const messages: CanonicalMessage[] = history.map(m => ({
    messageId: m.messageId,
    role: m.role,
    content: m.content,
    turnIdx: m.turnIdx,
    seqInTurn: m.seqInTurn,
    createdAt: m.createdAt,
  }));
  const prior = readLatestOpTurn(op.id);
  return {
    opId: op.id,
    turnIdx,
    messages,
    providerState: prior?.providerState,
    tools: [],
  };
}

interface DispatchedTools {
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
}

async function dispatchTools(opId: string, turnIdx: number, calls: ToolCall[]): Promise<DispatchedTools> {
  if (calls.length === 0) return { toolMessages: [], toolSummary: [] };
  const dispatcher = getToolDispatcher();
  const toolMessages: CommitTurnMessage[] = [];
  const toolSummary: ToolCallSummary[] = [];

  for (const call of calls) {
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
