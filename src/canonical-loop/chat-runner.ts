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
import { enableDefaultMiddlewareStack, getActiveMiddlewareStack } from "./middlewares/host.js";
import { createAnthropicAdapter } from "./adapters/anthropic.js";
import { subscribeOpStream, subscribeOpEvents } from "./control-api.js";
import { appendOpMessage } from "./store.js";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";
import type { OpMessageRow, CanonicalEvent, StateChangedBody } from "./types.js";
import { isTerminalState, type TerminalState } from "./terminal-states.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.chat-runner");

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

/**
 * Inverse of `seedOpMessages` — converts a single canonical `OpMessageRow`
 * back into a `ChatCompletionMessageParam` suitable for `session.messages`.
 *
 * Used by the chat route at turn-end to read the just-finished turn's rows
 * out of `op-messages.jsonl` and append them to the per-session log. This
 * is the path that captures tool_calls and tool_result rows correctly —
 * the old chat.ts synthesis only persisted assistant text, so tool-using
 * turns lost their structured history across turn boundaries.
 *
 * Returns null for rows that should not appear in session.messages
 * (system rows, control rows, or rows with no projectable content).
 */
export function opMessageRowToChatParam(row: OpMessageRow): ChatCompletionMessageParam | null {
  const content = (row.content ?? {}) as {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
  };
  const text = typeof content.text === "string" ? content.text : "";

  if (row.role === "user") {
    // Strip the engine-side temporal marker that turn-loop wraps mid-turn
    // injects with — the chat UI / future turns should see what the user
    // actually typed, not the wrapped form.
    const cleaned = text.replace(/^\[mid-turn user message\]\s*/, "");
    if (!cleaned) return null;
    return { role: "user", content: cleaned };
  }
  if (row.role === "assistant") {
    if (Array.isArray(content.toolCalls) && content.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: text,
        tool_calls: content.toolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as ChatCompletionMessageParam;
    }
    if (!text) return null;
    return { role: "assistant", content: text };
  }
  if (row.role === "tool_result") {
    // Tool result rows have two shapes:
    //   - just-written by turn-loop: { toolCallId, result, status }
    //   - re-seeded from session.messages: { text, toolCallId }
    // Plus the new image-envelope from chat-tool-dispatcher:
    //   { toolCallId, result: { text, images }, status }
    // All three need to produce a non-empty content field on the chat
    // tool message. Empty content gets dropped by seedOpMessages's
    // filter, orphans the assistant tool_call on the next turn, and
    // triggers Codex 400 "No tool output found for function call X".
    let resultText = text;
    if (!resultText) {
      const r = (content as { result?: unknown }).result;
      if (typeof r === "string") {
        resultText = r;
      } else if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
        resultText = (r as { text: string }).text;
      } else if (r != null) {
        resultText = JSON.stringify(r);
      }
    }
    return {
      role: "tool",
      tool_call_id: content.toolCallId ?? "",
      content: resultText,
    } as ChatCompletionMessageParam;
  }
  return null;
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

    // Carry tool_calls through on assistant messages. The codex adapter's
    // convertMessages reads `content.toolCalls` and emits function_call
    // items in the API input; without this round-trip, a session whose
    // history includes a tool-using turn surfaces orphan
    // function_call_outputs ("No tool call found for function call output
    // with call_id ..." 400s on Codex). The tool_call's id is the compound
    // call_id|item_id encoded by codex-message-convert.
    let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    if (role === "assistant") {
      const m = msg as ChatCompletionMessageParam & {
        tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        toolCalls = m.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        }));
      }
    }

    // Skip empty assistant rows ONLY when there are also no tool calls —
    // a tool-only assistant turn (no text, just function calls) is
    // structurally important for Codex pairing and must be persisted.
    // Same rule applies to tool_result rows: a tool message with empty
    // text but a real tool_call_id is still load-bearing — dropping it
    // orphans the matching assistant tool_call on the next Codex turn,
    // surfacing as the "No tool output found for function call X" 400
    // error. So preserve tool_result rows whenever they carry a
    // tool_call_id, regardless of text content.
    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId) continue;

    // For tool_result rows, embed tool_call_id inside the content payload
    // (canonical OpMessageRow has a free-form `content` field; the adapter
    // reads tool_call_id from there when converting to provider messages).
    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }
    if (role === "assistant" && toolCalls) {
      content = { text, toolCalls };
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
  // Image attachments ride on the same content payload — adapters extract
  // `images` and convert to their provider's wire format (OpenAI multi-
  // part for OpenAI-compat, image content blocks for Anthropic).
  const userContent: { text: string; images?: PreparedAgentRequest["images"] } = { text: currentMessage };
  if (prepared.images && prepared.images.length > 0) userContent.images = prepared.images;
  appendOpMessage({
    messageId: `um-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn,
    role: "user",
    content: userContent,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Run a chat turn through the canonical-loop. Returns an async generator
 * of `ServerEvent`s — text streams, tool cards, errors, and the terminal
 * `done` event with usage. Caller forwards these to SSE/WS.
 */
export async function* runChatViaCanonical(ctx: CanonicalChatContext): AsyncGenerator<ServerEvent> {
  // Install the legacy safety stack once per process. The stack is opt-in
  // by default; chat is the first caller and turns it on. P4.C3-C5 will
  // wire the same opt-in into cron / sub-agent / voice / worker-pool
  // entry points as those non-chat callers migrate to canonical.
  if (getActiveMiddlewareStack().length === 0) {
    enableDefaultMiddlewareStack();
  }

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
  const forcedToolChoice = ctx.prepared.toolChoice;
  if (ctx.prepared.provider === "anthropic") {
    registerAdapterForOp(op.id, () =>
      createAnthropicAdapter({
        systemPrompt: ctx.prepared.systemPrompt,
        model: ctx.prepared.model,
        sessionId: ctx.sessionId,
        forcedToolChoice,
      }),
    );
  } else if (ctx.prepared.provider === "codex") {
    const { createCodexAdapter } = await import("./adapters/codex.js");
    registerAdapterForOp(op.id, () =>
      createCodexAdapter({
        systemPrompt: ctx.prepared.systemPrompt,
        model: ctx.prepared.model,
        sessionId: ctx.sessionId,
        forcedToolChoice,
      }),
    );
  } else {
    // OpenAI-compat providers: local, ollama-cloud, xai, openai, gemini,
    // custom. One adapter, one wire shape — only the baseURL + apiKey
    // swap per provider. For "local" we additionally check the per-model
    // cloud-Ollama set, so picking a Turbo model from inside the local
    // dropdown still routes to the cloud endpoint.
    const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("./adapters/openai-compat.js");
    let target = await resolveOpenAICompatTarget(ctx.prepared.provider, ctx.prepared);
    if (ctx.prepared.provider === "local") {
      const { isCloudModel, getCloudOllamaCallTarget } = await import("../ollama-cloud.js");
      if (isCloudModel(ctx.prepared.model)) {
        const cloudTarget = getCloudOllamaCallTarget();
        if (cloudTarget) target = cloudTarget;
      }
    }
    if (!target) {
      // No usable target (e.g. ollama-cloud picked but no key configured,
      // or custom provider without baseURL). Surface the failure cleanly
      // by registering a no-op adapter that errors on first runTurn.
      throw new Error(`provider ${ctx.prepared.provider} has no usable OpenAI-compat target — check API key and base URL config`);
    }
    const finalTarget = target;
    registerAdapterForOp(op.id, () =>
      createOpenAICompatAdapter({
        systemPrompt: ctx.prepared.systemPrompt,
        model: ctx.prepared.model,
        baseURL: finalTarget.baseURL,
        apiKey: finalTarget.apiKey,
        temperature: ctx.prepared.temperature,
        sessionId: ctx.sessionId,
        forcedToolChoice,
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
  let terminal: TerminalState | null = null;
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
    const c = chunk as { delta?: string; replace?: boolean; text?: string } | null;
    // Adapter-initiated text replacement (e.g. tool-call-from-text
    // extractor stripping JSON that was already streamed). Forward to
    // the client as a stream event with replace:true so it swaps the
    // bubble's text rather than appending.
    if (c?.replace === true) {
      eventQueue.push({ type: "stream", replace: true, text: c.text ?? "" });
      wake();
      return;
    }
    const delta = c?.delta;
    if (typeof delta !== "string" || delta.length === 0) return;
    eventQueue.push({ type: "stream", delta });
    wake();
  });

  const offEvents = subscribeOpEvents(op.id, (event: CanonicalEvent) => {
    if (event.type === "state_changed") {
      const body = event.body as StateChangedBody | undefined;
      const to = body?.to;
      if (isTerminalState(to)) {
        terminal = to;
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
