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
import { createHash, randomUUID } from "node:crypto";
import type { Adapter, AdapterReport, TurnInput } from "./adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "./contract-types.js";
import type {
  CanonicalMessageRole,
  OpMessageRow,
  ProviderStateEnvelope,
  RedirectInstruction,
  ToolCallSummary,
} from "./types.js";
import { appendOpMessage, readLatestOpTurn, readOpMessages } from "./store.js";
import { emit, publishStreamChunk } from "./event-emitter.js";
import { commitTurn, type CommitTurnMessage } from "./checkpoint.js";
import { getToolDispatcher, getToolsForOp } from "./runtime.js";
import { readOp } from "../workers/op-store.js";
import type { Op } from "../workers/types.js";
import { drainInjects } from "../agent-loop/inject-queue.js";
import { getSessionForOp } from "../workers/session-bridge.js";

export interface DriveTurnResult {
  terminalReason: "done" | "error" | null;
  toolCount: number;
  messageCount: number;
  /** True if the turn was aborted mid-flight via cancel; commit was skipped. */
  cancelled: boolean;
}

export interface DriveTurnOptions {
  /**
   * Optional cancel-check called after the adapter resolves runTurn and
   * again after tool dispatch. If it returns true, the partial turn is
   * discarded — no commitTurn, no op_turns row, no op_messages, no
   * turn_committed event (PRD §13: cancel discards the partial turn).
   */
  isCancelled?: () => boolean;
}

export async function driveTurn(
  op: Op,
  adapter: Adapter,
  turnIdx: number,
  opts: DriveTurnOptions = {},
): Promise<DriveTurnResult> {
  // Snapshot the redirect column from disk BEFORE emitting `turn_started`.
  // The bus dispatch is synchronous, so a `turn_started` subscriber that
  // calls `opRedirect` lands on disk AFTER this read — meaning a redirect
  // arriving during this turn applies to the NEXT turn (PRD acceptance #5:
  // mid-turn redirect → next-turn application). A redirect that arrived
  // BEFORE the worker entered driveTurn is captured here and folded into
  // this turn's prompt.
  const pendingRedirect = readPendingRedirect(op.id);
  emit(op.id, "turn_started", { turnIdx });

  // Mid-turn injects: messages the user typed during a previous turn / tool
  // call, queued by chat-ws via pushInject(). Drain into op_messages BEFORE
  // buildTurnInput so the adapter sees them inline as user messages on this
  // turn. Mirrors agent-loop's interjectDrainMiddleware. Scoped to chat_turn
  // so background/delegated workers sharing the session don't drain the
  // user's chat-bound injects.
  if (op.type === "chat_turn") drainInjectsIntoTurn(op, turnIdx);

  const input = buildTurnInput(op, turnIdx, pendingRedirect);

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

  // Cancel-aware bail BEFORE tool dispatch and BEFORE commit. The adapter
  // has already returned (via abort or natural completion); the worker's
  // cancel handler is in charge of the running→cancelling→cancelled
  // transitions, and we must not commit a partial turn.
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: true };
  }

  const { toolMessages, toolSummary } = await dispatchTools(op.id, turnIdx, toolCalls);

  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: toolSummary.length, messageCount: 0, cancelled: true };
  }

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
    redirectConsumed: pendingRedirect != null,
    redirectInstructionId: pendingRedirect?.instructionId,
  });

  return { terminalReason, toolCount: toolSummary.length, messageCount: allMessages.length, cancelled: false };
}

function buildTurnInput(
  op: Op,
  turnIdx: number,
  pendingRedirect: RedirectInstruction | null,
): TurnInput {
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
  // Tools come from the per-op registry (chat-runner registers them on
  // submit; legacy worker-pool ops don't register and get []). Without
  // this, the adapter never tells the model about its tool surface and
  // tool-needing chats degrade to "I'm in planning mode" responses.
  const input: TurnInput = {
    opId: op.id,
    turnIdx,
    messages,
    providerState: prior?.providerState,
    tools: getToolsForOp(op.id),
  };
  if (pendingRedirect) input.pendingRedirect = pendingRedirect;
  return input;
}

function readPendingRedirect(opId: string): RedirectInstruction | null {
  const fresh = readOp(opId);
  return fresh?.canonical?.redirectInstruction ?? null;
}

function drainInjectsIntoTurn(op: Op, turnIdx: number): void {
  const sessionId = getSessionForOp(op.id);
  if (!sessionId) return;
  const injects = drainInjects(sessionId);
  if (injects.length === 0) return;
  // Offset past any pre-existing rows for this turn (e.g. the seeded turn-0
  // user message) so (op_id, turn_idx, seq_in_turn) stays unique.
  let seqInTurn = readOpMessages(op.id).filter(m => m.turnIdx === turnIdx).length;
  const now = new Date().toISOString();
  for (const text of injects) {
    const row: OpMessageRow = {
      messageId: `inject-${op.id}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId: op.id,
      turnIdx,
      seqInTurn,
      role: "user",
      content: { text },
      createdAt: now,
    };
    appendOpMessage(row);
    emit(op.id, "message_appended", { turnIdx, role: row.role, messageId: row.messageId });
    seqInTurn += 1;
  }
}

interface DispatchedTools {
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
}

async function dispatchTools(opId: string, turnIdx: number, calls: ToolCall[]): Promise<DispatchedTools> {
  if (calls.length === 0) return { toolMessages: [], toolSummary: [] };
  const dispatcher = getToolDispatcher(opId);
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
