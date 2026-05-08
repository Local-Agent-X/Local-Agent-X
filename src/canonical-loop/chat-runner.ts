/**
 * Canonical-loop chat runner.
 *
 * The seam where "chat turn" meets canonical-loop. Given a fully-prepared
 * agent request (from `prepareAgentRequest` — memory hits, AGENTS rules,
 * recent turns, tools, system prompt), this module:
 *
 *   1. Builds an `op_chat_turn` op
 *   2. Pre-seeds `op_messages` with the prepared conversation history so
 *      the canonical adapter sees the full context the legacy path would
 *      have shipped
 *   3. Registers a per-op AnthropicAdapter using the prepared system prompt
 *      and model
 *   4. Registers a per-op tool dispatcher that delegates to the chat tool
 *      runtime (`tool-executor.ts`) — so canonical chat uses the SAME tool
 *      implementations as legacy chat
 *   5. Submits via `canonicalLoopEntry`
 *   6. Subscribes to op stream + events, yields `ServerEvent`s for the
 *      caller (chat route) to forward to SSE/WS
 *   7. Awaits terminal state, emits `done`, cleans up registrations
 *
 * Every chat turn that takes this path produces the same observable
 * artifacts as a worker delegation: canonical events, op_messages, op_turns,
 * soak telemetry. That's the unification — chat becomes "just another op"
 * from the canonical-loop's perspective.
 */
import { randomUUID } from "node:crypto";
import { newOpId, writeOp } from "../workers/op-store.js";
import { buildContextPack } from "../workers/context-pack-builder.js";
import { getRetryPolicy } from "../workers/heartbeat.js";
import { trackOpForSession } from "../workers/session-bridge.js";
import type { Op, OpVisibility } from "../workers/types.js";
import type { PreparedAgentRequest } from "../agent-request/types.js";
import type { ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { canonicalLoopEntry } from "./index.js";
import {
  registerAdapterForOp,
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
  registerToolsForOp,
  unregisterToolsForOp,
} from "./runtime.js";
import { createAnthropicAdapter } from "./adapters/anthropic.js";
import { subscribeOpStream, subscribeOpEvents } from "./control-api.js";
import { appendOpMessage } from "./store.js";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";
import type { OpMessageRow, CanonicalEvent, StateChangedBody } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.chat-runner");

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export interface CanonicalChatContext {
  message: string;
  sessionId: string;
  prepared: PreparedAgentRequest;
  /** Full tool list to register with the dispatcher (post IDE filtering). */
  tools: PreparedAgentRequest["tools"];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  /** Forwarder for tool execution events (cards, mcp_activity, etc.). */
  onToolEvent?: (event: ServerEvent) => void;
  /** Per-turn abort signal — wired to tool execution; canonical lifecycle
   *  has its own cancel API for cancelling the model loop. */
  signal?: AbortSignal;
}

function messageRoleToCanonicalRole(role: ChatCompletionMessageParam["role"]): "user" | "assistant" | "tool_result" | null {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool_result";
    case "system":
      // Canonical messages don't model "system" as a per-row role — system
      // prompt lives on the adapter. Drop system rows from cleanHistory;
      // their content is already baked into prepared.systemPrompt by
      // prepareAgentRequest.
      return null;
    default: return null;
  }
}

function extractTextContent(content: ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!content || !Array.isArray(content)) return "";
  // Multi-part content: concatenate text parts; ignore image parts (handled
  // separately by the adapter when image support lands).
  return content
    .filter((p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map(p => p.text)
    .join("\n");
}

/**
 * Pre-seed `op_messages` with the prepared conversation history followed by
 * the current user message. This runs BEFORE `canonicalLoopEntry` so the
 * loop's worker, on first turn, sees the full history instead of just the
 * default `seedInitialUserMessage` rendering.
 */
function seedOpMessages(opId: string, prepared: PreparedAgentRequest, currentMessage: string): void {
  let seqInTurn = 0;
  const turnIdx = 0;

  for (const msg of prepared.cleanHistory) {
    const role = messageRoleToCanonicalRole(msg.role);
    if (!role) continue;
    const text = extractTextContent(msg.content);
    if (!text) continue;

    // For tool_result rows, embed tool_call_id inside the content payload
    // (canonical OpMessageRow has a free-form `content` field; the adapter
    // reads tool_call_id from there when converting to provider messages).
    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }

    const row: OpMessageRow = {
      messageId: `hist-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId,
      turnIdx,
      seqInTurn,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    appendOpMessage(row);
    seqInTurn += 1;
  }

  // Current user message — last in the seed so the model sees it as the
  // "ask". seedInitialUserMessage is a no-op when op_messages is non-empty,
  // so this row replaces its default behavior with our prepared payload.
  appendOpMessage({
    messageId: `um-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn,
    role: "user",
    content: { text: currentMessage },
    createdAt: new Date().toISOString(),
  });
}

/**
 * Run a chat turn through the canonical-loop. Returns an async generator
 * of `ServerEvent`s — text streams, tool cards, errors, and the terminal
 * `done` event with usage. Caller forwards these to SSE/WS.
 */
export async function* runChatViaCanonical(ctx: CanonicalChatContext): AsyncGenerator<ServerEvent> {
  // 1. Build the op skeleton. Tools list is recorded on the contextPack so
  //    the adapter sees them via TurnInput.tools (passed by turn-loop from
  //    op state). lane=interactive so soak telemetry classifies it correctly.
  const contextPack = await buildContextPack({
    description: ctx.message,
    successCriteria: [],
    constraints: [],
    lane: "interactive",
    // Pass through the actual provider so soak-metrics' `provider` column
    // matches the `adapter` column. Earlier this was hardcoded "anthropic"
    // and Codex turns surfaced as `provider:"anthropic" adapter:"codex"`,
    // breaking apples-to-apples filtering.
    preferredProvider: ctx.prepared.provider,
    budget: { maxIterations: ctx.prepared.maxIterations || 30, maxWallTimeMs: 5 * 60 * 1000 },
  });

  const op: Op = {
    id: newOpId("op_chat_turn"),
    type: "chat_turn",
    task: ctx.message,
    contextPack,
    lane: "interactive",
    retryPolicy: getRetryPolicy("chat_turn"),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  trackOpForSession(op.id, ctx.sessionId, ctx.message);
  writeOp(op);

  // 2. Pre-seed history + current user message into op_messages. The first
  //    turn's runTurn will read these via the canonical-loop's message replay.
  seedOpMessages(op.id, ctx.prepared, ctx.message);

  // 3. Per-op adapter — uses the FULL prepared system prompt (memory,
  //    AGENTS, history is already in op_messages, so the system prompt
  //    is the static system context only). Provider follows the prepared
  //    request, so when the user picks Codex in settings the chat goes
  //    through CodexAdapter end-to-end (pure-canonical, no random canary).
  if (ctx.prepared.provider === "codex") {
    const { createCodexAdapter } = await import("./adapters/codex.js");
    registerAdapterForOp(op.id, () =>
      createCodexAdapter({
        systemPrompt: ctx.prepared.systemPrompt,
        model: ctx.prepared.model,
        sessionId: ctx.sessionId,
      }),
    );
  } else {
    registerAdapterForOp(op.id, () =>
      createAnthropicAdapter({
        systemPrompt: ctx.prepared.systemPrompt,
        model: ctx.prepared.model,
        sessionId: ctx.sessionId,
      }),
    );
  }

  // 4. Per-op tool dispatcher — wraps tool-executor with this turn's
  //    security context. Cleaned up in `finally` below.
  registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools: ctx.tools,
    security: ctx.security,
    toolPolicy: ctx.toolPolicy,
    threatEngine: ctx.threatEngine,
    rbac: ctx.rbac,
    callerRole: ctx.callerRole,
    sessionId: ctx.sessionId,
    onEvent: ctx.onToolEvent,
    signal: ctx.signal,
  }));

  // 4b. Tool descriptors for the adapter — turn-loop reads these into
  //     TurnInput.tools so the model sees the available tool surface.
  //     Without this the adapter receives `tools: []` and chats refuse
  //     tool work ("I'm in planning mode" / "I can't open browsers").
  //     `parameters` on ToolDefinition maps to `inputSchema` on
  //     ToolDescriptor — the canonical contract uses the latter name.
  const toolDescriptors = ctx.tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
  registerToolsForOp(op.id, toolDescriptors);

  // 5. Subscribe BEFORE submitting so we don't miss the synchronous
  //    `state_changed: queued` event that canonicalLoopEntry emits.
  const eventQueue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let terminal: "succeeded" | "failed" | "cancelled" | null = null;
  let usageInputTokens = 0;
  let usageOutputTokens = 0;

  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const offStream = subscribeOpStream(op.id, (chunk) => {
    const c = chunk as { delta?: string } | null;
    const delta = c?.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    eventQueue.push({ type: "stream", delta });
    wake();
  });

  const offEvents = subscribeOpEvents(op.id, (event: CanonicalEvent) => {
    if (event.type === "state_changed") {
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (to && TERMINAL_STATES.has(to)) {
        terminal = to as "succeeded" | "failed" | "cancelled";
        wake();
      }
      return;
    }
    if (event.type === "error") {
      const b = (event.body ?? {}) as Record<string, unknown>;
      const code = (b.code as string | undefined) ?? "error";
      const message = (b.message as string | undefined) ?? "(no message)";
      eventQueue.push({ type: "error", message: `${code}: ${message.slice(0, 240)}` });
      wake();
      return;
    }
    if (event.type === "turn_committed") {
      // No user-visible event today; reserved hook for future "round N" UI.
      return;
    }
  });

  // 6. Submit — synchronous bookkeeping; loop runs on the scheduler.
  try {
    canonicalLoopEntry(op, { sessionId: ctx.sessionId });
    logger.info(`[chat-runner] submitted op ${op.id} sess=${ctx.sessionId.slice(0, 16)} model=${ctx.prepared.model} tools=${ctx.tools.length}`);
    // Tell the UI the opId immediately so it can track for reconnect /
    // cancel — independent of any HTTP/SSE connection that may drop.
    eventQueue.push({ type: "chat_op_started", opId: op.id });
    wake();
  } catch (e) {
    yield { type: "error", message: `canonical chat submit failed: ${(e as Error).message}` };
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    offStream();
    offEvents();
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
    return;
  }

  // 7. Drain events until terminal. Yield queued events before sleeping.
  try {
    while (true) {
      while (eventQueue.length > 0) {
        const ev = eventQueue.shift()!;
        yield ev;
      }
      if (terminal !== null) break;
      await new Promise<void>(r => { waiter = r; });
    }

    yield {
      type: "done",
      usage: {
        promptTokens: usageInputTokens,
        completionTokens: usageOutputTokens,
        totalTokens: usageInputTokens + usageOutputTokens,
      },
    };
  } finally {
    offStream();
    offEvents();
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
  }
}
