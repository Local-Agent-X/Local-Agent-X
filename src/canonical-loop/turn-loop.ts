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
import {
  buildCanonicalLoopContext,
  getActiveMiddlewareStack,
  runMiddlewarePhase,
  type FiredMiddlewareResult,
} from "./middlewares/host.js";
import type { CanonicalToolResultView } from "./middlewares/types.js";
import { getEvidenceHistory } from "./middlewares/evidence-history.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.turn-loop");

export interface DriveTurnResult {
  terminalReason: "done" | "error" | null;
  toolCount: number;
  messageCount: number;
  /** True if the turn was aborted mid-flight via cancel; commit was skipped. */
  cancelled: boolean;
  /**
   * Set when a middleware in the canonical safety stack returned a non-
   * "continue" verdict. The worker uses this to override the natural
   * "break on terminal" logic — a `nudge` keeps the worker looping
   * (synthetic user message has been appended to op_messages), an `abort`
   * forces the worker to exit and transition the op to failed.
   */
  middlewareDirective?: {
    kind: "nudge" | "abort";
    reason: string;
    firedBy: string;
    message?: string;
  };
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

  // ── Phase 1: beforeTurn middlewares ──
  // Snapshot a fresh CanonicalLoopContext from disk + op state. A `nudge`
  // here appends a synthetic user message at the CURRENT turnIdx so this
  // turn's adapter sees it (mirrors agent-loop's beforeIteration→push-then-
  // restart-iteration). An `abort` short-circuits the whole turn — no
  // adapter call, no tool dispatch — and the worker exits.
  const evidenceHistory = getEvidenceHistory(op.id);
  const middlewareStack = getActiveMiddlewareStack();
  const beforeCtx = buildCanonicalLoopContext({
    op, turnIdx,
    tools: getToolsForOp(op.id),
    evidenceHistory,
  });
  const beforeRes = await runMiddlewarePhase(beforeCtx, "beforeTurn", middlewareStack);
  if (beforeRes.kind === "abort") {
    return middlewareAbortResult(op, turnIdx, beforeRes);
  }
  if (beforeRes.kind === "nudge") {
    appendNudgeAsUserMessage(op.id, turnIdx, beforeRes.message);
    // Fall through — next read of op_messages (buildTurnInput, below) picks
    // the nudge up and ships it to the adapter on this turn.
  }

  const input = buildTurnInput(op, turnIdx, pendingRedirect);

  const finalized: CanonicalMessage[] = [];
  const toolCalls: ToolCall[] = [];
  let adapterError: { code: string; message: string } | null = null;
  /** Sticky middleware directive across the turn's phases. The first
   *  non-`continue` verdict (from any phase) wins — same short-circuit
   *  semantics as agent-loop's runPhase per-phase short-circuit, lifted
   *  to a per-turn bubble so the worker can apply the verdict after
   *  commit. beforeTurn nudges are already consumed (synthetic message
   *  injected into THIS turn); we don't bubble them up. */
  let middlewareDirective:
    | { kind: "nudge"; reason: string; firedBy: string; message: string }
    | { kind: "abort"; reason: string; firedBy: string; message?: string }
    | null = null;

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
    if (r.kind === "stream_redact") {
      // The adapter post-processed its already-streamed text (e.g.
      // tool-call extraction) and wants the UI to retract part of it.
      // Re-uses the stream-chunk publish path with a `replace: true`
      // marker so the client can swap the bubble's text rather than
      // append.
      publishStreamChunk(op.id, { replace: true, text: r.replacementText });
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

  // ── Phase 2: afterModelCall middlewares ──
  // Build a fresh context view from this turn's emitted assistant text +
  // tool calls. Middlewares may MUTATE ctx.toolCalls (auto-build-app
  // appends a synthetic build_app call) — we use the same array reference
  // turn-loop will dispatch from, so any synthetic call lands in the
  // toolCalls list before dispatchTools fires.
  const assistantText = finalized
    .filter(m => m.role === "assistant")
    .map(m => extractText(m.content))
    .join("");
  const afterModelCtx = buildCanonicalLoopContext({
    op, turnIdx,
    tools: getToolsForOp(op.id),
    toolCalls,
    assistantContent: assistantText,
    evidenceHistory,
  });
  // Wire the live toolCalls array so auto-build-app's push mutates the
  // dispatcher's input. buildCanonicalLoopContext already passes it; this
  // is documentation for the next reader.
  afterModelCtx.toolCalls = toolCalls;
  const afterModelRes = await runMiddlewarePhase(afterModelCtx, "afterModelCall", middlewareStack);
  if (afterModelRes.kind === "abort") {
    middlewareDirective = {
      kind: "abort",
      reason: afterModelRes.reason,
      firedBy: afterModelRes.firedBy ?? "unknown",
      message: afterModelRes.message,
    };
  } else if (afterModelRes.kind === "nudge") {
    middlewareDirective = {
      kind: "nudge",
      reason: afterModelRes.reason,
      firedBy: afterModelRes.firedBy ?? "unknown",
      message: afterModelRes.message,
    };
  }

  const toolDispatchStart = Date.now();
  // If a middleware aborted, skip tool dispatch — same effect as agent-
  // loop's runPhase short-circuit before tool execution.
  const { toolMessages, toolSummary } = middlewareDirective?.kind === "abort"
    ? { toolMessages: [] as CommitTurnMessage[], toolSummary: [] as ToolCallSummary[] }
    : await dispatchTools(op.id, turnIdx, toolCalls, opts.isCancelled);
  const toolDispatchMs = Date.now() - toolDispatchStart;

  if (opts.isCancelled?.()) {
    return { terminalReason: null, toolCount: toolSummary.length, messageCount: 0, cancelled: true };
  }

  // ── Phase 3: afterToolExecution middlewares ──
  // Only run when an abort hasn't already short-circuited the turn. The
  // first non-continue verdict from afterModelCall wins; afterToolExecution
  // only refines (not overrides) — matches agent-loop's per-phase ordering.
  if (middlewareDirective === null) {
    const toolResultsView: CanonicalToolResultView[] = toolMessages.map((tm, i) => ({
      toolName: toolSummary[i]?.tool ?? "unknown",
      toolCallId: (tm.content as { toolCallId?: string })?.toolCallId ?? "",
      content: extractToolResultText(tm.content),
    }));
    const afterToolCtx = buildCanonicalLoopContext({
      op, turnIdx,
      tools: getToolsForOp(op.id),
      toolCalls,
      toolResults: toolResultsView,
      assistantContent: assistantText,
      evidenceHistory,
    });
    const afterToolRes = await runMiddlewarePhase(afterToolCtx, "afterToolExecution", middlewareStack);
    if (afterToolRes.kind === "abort") {
      middlewareDirective = {
        kind: "abort",
        reason: afterToolRes.reason,
        firedBy: afterToolRes.firedBy ?? "unknown",
        message: afterToolRes.message,
      };
    } else if (afterToolRes.kind === "nudge") {
      middlewareDirective = {
        kind: "nudge",
        reason: afterToolRes.reason,
        firedBy: afterToolRes.firedBy ?? "unknown",
        message: afterToolRes.message,
      };
    }
  }

  const allMessages: CommitTurnMessage[] = [];
  for (const m of finalized) {
    allMessages.push({ messageId: m.messageId, role: m.role, content: m.content });
  }
  for (const tm of toolMessages) allMessages.push(tm);

  const providerState: ProviderStateEnvelope = result.providerState;
  // A middleware abort forces the turn to terminal=error so the worker
  // breaks the drive loop. A nudge does NOT force terminal — the
  // adapter's natural terminalReason still applies (so a turn that
  // ended with tool calls just continues into the next turn where the
  // nudge user-message is visible).
  const middlewareAborted = middlewareDirective?.kind === "abort";
  const terminalReason: "done" | "error" | null = middlewareAborted
    ? "error"
    : (result.terminalReason ?? (adapterError ? "error" : null));

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

  // For nudges, append the synthetic user message at turnIdx+1 so the next
  // driveTurn sees it via buildTurnInput's op_messages read. For aborts,
  // emit a stopped event so chat UI surfaces a one-line reason instead of a
  // frozen cursor. Mirrors agent-loop/run.ts:surfaceMiddlewareAbort.
  if (middlewareDirective?.kind === "nudge") {
    appendNudgeAsUserMessage(op.id, turnIdx + 1, middlewareDirective.message);
  }
  if (middlewareAborted) {
    emit(op.id, "error", {
      code: "middleware-abort",
      message: middlewareDirective!.message ?? `Turn aborted by ${middlewareDirective!.firedBy}.`,
      retryable: false,
    });
  }

  return {
    terminalReason,
    toolCount: toolSummary.length,
    messageCount: allMessages.length,
    cancelled: false,
    middlewareDirective: middlewareDirective
      ? {
          kind: middlewareDirective.kind,
          reason: middlewareDirective.reason,
          firedBy: middlewareDirective.firedBy,
          message: middlewareDirective.kind === "nudge"
            ? middlewareDirective.message
            : middlewareDirective.message,
        }
      : undefined,
  };
}

// ── Middleware helpers ────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; result?: unknown };
    if (typeof c.text === "string") return c.text;
    if (typeof c.result === "string") return c.result;
  }
  return "";
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as { text?: unknown; result?: unknown };
    if (typeof c.text === "string") return c.text;
    const r = c.result;
    if (typeof r === "string") return r;
    if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
      return (r as { text: string }).text;
    }
    if (r != null) {
      try { return JSON.stringify(r); } catch { return ""; }
    }
  }
  return "";
}

/** Append a synthetic user-role op_message carrying a middleware nudge.
 *  Sits in op_messages at (turnIdx, seqInTurn=N) where N is one past any
 *  existing row in that turn. The next driveTurn(turnIdx) — or this turn,
 *  for a beforeTurn nudge — sees it via the standard buildTurnInput
 *  history read. */
function appendNudgeAsUserMessage(opId: string, turnIdx: number, message: string): void {
  const existing = readOpMessages(opId).filter(m => m.turnIdx === turnIdx).length;
  const row: OpMessageRow = {
    messageId: `nudge-${opId}-${turnIdx}-${existing}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn: existing,
    // role MUST stay "user" — providers need this as input so the model
    // treats the nudge as a user instruction on the next turn. The UI
    // distinguishes nudges from real user messages via `content.kind`
    // below, so it can render them as small italic system notes (or hide
    // them entirely) without ever surfacing the synthetic message as if
    // the user typed it. Adapters' canonicalToTransport only emits
    // `content.text` so the `kind` marker stays on our side of the wire.
    role: "user",
    content: { text: message, kind: "nudge" },
    createdAt: new Date().toISOString(),
  };
  appendOpMessage(row);
  emit(opId, "message_appended", { turnIdx, role: row.role, messageId: row.messageId });
}

function middlewareAbortResult(
  op: Op,
  turnIdx: number,
  fired: FiredMiddlewareResult,
): DriveTurnResult {
  if (fired.kind !== "abort") throw new Error("middlewareAbortResult requires abort verdict");
  emit(op.id, "error", {
    code: "middleware-abort",
    message: fired.message ?? `Turn aborted by ${fired.firedBy ?? "middleware"}.`,
    retryable: false,
  });
  // Reserved for future per-turn telemetry; the abort emit above already
  // surfaces the turn's stop reason.
  void turnIdx;
  return {
    terminalReason: "error",
    toolCount: 0,
    messageCount: 0,
    cancelled: false,
    middlewareDirective: {
      kind: "abort",
      reason: fired.reason ?? "unknown",
      firedBy: fired.firedBy ?? "unknown",
      message: fired.message,
    },
  };
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

async function dispatchTools(
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
