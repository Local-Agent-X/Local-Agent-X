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
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.turn-loop");

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

  // Idle-event detection — provider-agnostic. Watches the report stream
  // for ANY activity (stream chunks, tool calls, finalized messages,
  // errors). If nothing arrives for IDLE_TIMEOUT_MS the adapter is
  // assumed stuck and we abort with reason "idle-stalled" so transports
  // that recognize it (warm-pool's reason matcher) can hard-kill the
  // underlying CLI/HTTP connection. Productive long turns reset the
  // timer on every event and never trip this; only true stalls die.
  // Lives here so any future adapter (xai, gemini, local) inherits it.
  // Default 600s. Used to be 120s, which killed legitimately long
  // thinking + tool-prep turns (Opus on a big prompt, planning convos
  // with the methodology body inlined, etc.). 10 min is still tight
  // enough that true stalls die; productive turns reset the timer on
  // every adapter event so they never trip it. Override via env var.
  const idleMs = parseInt(process.env.LAX_CANONICAL_IDLE_TIMEOUT_MS ?? "600000", 10);
  let lastReportAt = Date.now();
  let idleFired = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (Date.now() - lastReportAt < idleMs) {
        armIdleTimer();
        return;
      }
      idleFired = true;
      adapterError = { code: "stalled", message: `no adapter reports for ${idleMs}ms — model presumed stuck` };
      emit(op.id, "error", { code: "stalled", message: adapterError.message, retryable: false });
      // Fire-and-forget — don't await; runTurn may still need a beat to
      // unwind. The reason propagates through the abort signal so
      // transports that watch reason (warm-pool kill on /idle|stalled|stop/)
      // do the right thing.
      void adapter.abort(new Error("idle-stalled"));
    }, idleMs);
  };
  armIdleTimer();

  // Time-component split for soak: how much of the turn was spent inside
  // the adapter's model call vs dispatching tools. Together with
  // commitMs (small, not separately tracked) and any caller-side prep,
  // they reconstruct where the turn's wall-clock went.
  const modelStart = Date.now();
  const result = await adapter.runTurn(input, (r: AdapterReport) => {
    lastReportAt = Date.now();
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
  if (idleTimer) clearTimeout(idleTimer);
  void idleFired; // surfaced via adapterError; reserved for telemetry
  const modelMs = Date.now() - modelStart;

  // Cancel-aware bail BEFORE tool dispatch and BEFORE commit. The adapter
  // has already returned (via abort or natural completion); the worker's
  // cancel handler is in charge of the running→cancelling→cancelled
  // transitions, and we must not commit a partial turn.
  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: 0, messageCount: 0, cancelled: true };
  }

  const toolDispatchStart = Date.now();
  const { toolMessages, toolSummary } = await dispatchTools(op.id, turnIdx, toolCalls);
  const toolDispatchMs = Date.now() - toolDispatchStart;

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
    modelMs,
    toolDispatchMs,
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
  // Pair this with chat-ws's `[ws-chat] inject sess=… len=N` enqueue line
  // for end-to-end visibility — until this log existed there was no way to
  // confirm an inject ever made it into an iteration vs sat in the queue
  // past the turn's end. The legacy agent-loop has its own
  // interjectDrainMiddleware that logs separately; chat turns go through
  // the canonical-loop and this function instead, so the message logged
  // there never fired for chats.
  const totalChars = injects.reduce((s, t) => s + t.length, 0);
  logger.info(`[interject-drain] consumed=${injects.length} sess=${sessionId} op=${op.id} turn=${turnIdx} totalChars=${totalChars}`);
  // Offset past any pre-existing rows for this turn (e.g. the seeded turn-0
  // user message) so (op_id, turn_idx, seq_in_turn) stays unique.
  let seqInTurn = readOpMessages(op.id).filter(m => m.turnIdx === turnIdx).length;
  const now = new Date().toISOString();
  for (const text of injects) {
    // Lightweight temporal-context marker. The model already has the
    // conversation history (so it knows what task is active) — what it
    // doesn't otherwise know is that this message arrived WHILE a turn
    // was running, not after it ended. Marking that fact is real signal:
    // it nudges the model to treat the message as relevant to the
    // current work without prescribing an interpretation. Deliberately
    // does NOT say "this applies to the active task" — the user might
    // be redirecting, and biasing toward continuation would suppress
    // legitimate course corrections.
    const framed = `[mid-turn user message] ${text}`;
    const row: OpMessageRow = {
      messageId: `inject-${op.id}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId: op.id,
      turnIdx,
      seqInTurn,
      role: "user",
      content: { text: framed },
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
