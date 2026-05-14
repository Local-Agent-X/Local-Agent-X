/**
 * Non-chat canonical-loop runner.
 *
 * Promise-based equivalent of `runChatViaCanonical` for callers that do not
 * stream events to a UI: cron missions, autopilot rounds, memory-dream
 * consolidation. Takes a runAgent-style signature (userMessage, history,
 * options) and returns an `AgentTurn`-shaped Promise so existing callers
 * swap with minimal diff.
 *
 * Wall-clock-ceiling: `options.wallClockMs` replaces the caller-side
 * `AbortController + setTimeout` pattern. A single in-runner timer calls
 * `opCancel(opId, "wall-clock-ceiling")` — canonical's state machine sees
 * a clean running → cancelling → cancelled transition instead of the
 * caller and the loop drifting apart on an out-of-band signal.
 *
 * External cancel: `options.signal` is wired to also call `opCancel`, so
 * callers that need an external cancel hook (e.g. cron's `registerRunAbort`
 * for "stop this running mission" API endpoints) keep their existing
 * AbortController interface — the signal now routes through canonical.
 *
 * Middleware stack: installs the default canonical safety stack on first
 * call (same opt-in mechanism `chat-runner` uses, sharing the same
 * `activeStack` module-level state).
 */
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { newOpId, writeOp } from "../workers/op-store.js";
import { buildContextPack } from "../workers/context-pack-builder.js";
import { getRetryPolicy } from "../workers/heartbeat.js";
import { trackOpForSession } from "../workers/session-bridge.js";
import type { Op, OpLane, OpVisibility } from "../workers/types.js";
import type { AgentOptions, ImageAttachment } from "../providers/types.js";
import type { AgentTurn } from "../types.js";

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
import { opCancel, subscribeOpEvents, subscribeOpStream } from "./control-api.js";
import { appendOpMessage, readOpMessages } from "./store.js";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";
import { opMessageRowToChatParam } from "./chat-runner.js";
import type { CanonicalEvent, CanonicalMessageRole, StateChangedBody } from "./types.js";
import { isTerminalState, type TerminalState } from "./terminal-states.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.agent-runner");
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

export interface CanonicalAgentOptions extends AgentOptions {
  /** Op-level wall-clock ceiling. Replaces caller-side setTimeout-driven
   *  AbortControllers — when this fires, the runner calls opCancel so
   *  canonical's state machine sees a clean running → cancelling → cancelled
   *  transition. Defaults to 15 min if omitted. */
  wallClockMs?: number;
  /** Canonical op type tag (drives retry policy + soak metrics buckets).
   *  Defaults to "agent_turn". Bucket-specific values: "autopilot_round",
   *  "scheduled_mission", "memory_consolidation". */
  opType?: string;
  /** Canonical lane. Defaults to "background" — non-chat callers don't
   *  share the `interactive` cap with live chat turns. */
  lane?: OpLane;
}

export async function runAgentViaCanonical(
  userMessage: string,
  history: ChatCompletionMessageParam[],
  options: CanonicalAgentOptions,
): Promise<AgentTurn> {
  if (getActiveMiddlewareStack().length === 0) {
    enableDefaultMiddlewareStack();
  }

  const opType = options.opType ?? "agent_turn";
  const lane: OpLane = options.lane ?? "background";
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const sessionId = options.sessionId ?? `agent-${randomUUID().slice(0, 8)}`;

  const contextPack = await buildContextPack({
    description: userMessage,
    successCriteria: [],
    constraints: [],
    lane,
    preferredProvider: options.provider,
    budget: {
      maxIterations: options.maxIterations || 30,
      maxWallTimeMs: wallClockMs,
    },
  });

  const op: Op = {
    id: newOpId(`op_${opType}`),
    type: opType,
    task: userMessage,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  trackOpForSession(op.id, sessionId, userMessage);
  writeOp(op);

  seedOpMessages(op.id, history, userMessage, options.images);
  await registerProviderAdapter(op.id, options, sessionId);

  // Bridge canonical opCancel → tool-execution AbortSignal so subprocesses
  // (self_edit's claude -p, build_app's codex --full-auto) actually die on
  // Stop instead of running to natural completion while the op hangs in
  // `cancelling`. Composes with the caller's optional external signal.
  const { bridgeOpCancelToToolSignal } = await import("./cancel-handler.js");
  const cancelBridge = bridgeOpCancelToToolSignal(op.id, options.signal);

  registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools: options.tools,
    security: options.security,
    toolPolicy: options.toolPolicy,
    threatEngine: options.threatEngine,
    rbac: options.rbac,
    callerRole: options.callerRole,
    sessionId,
    onEvent: options.onEvent,
    signal: cancelBridge.signal,
  }));

  registerToolsForOp(op.id, options.tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  })));

  let terminal: TerminalState | null = null;
  let errorMessage: string | undefined;
  let errorCode: string | undefined;
  let waiter: (() => void) | null = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

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
    if (event.type === "error" && !errorMessage) {
      const b = (event.body ?? {}) as Record<string, unknown>;
      errorCode = (b.code as string | undefined) ?? "error";
      const message = (b.message as string | undefined) ?? "(no message)";
      errorMessage = `${errorCode}: ${message}`;
    }
  });

  // Adapter-emitted text deltas live on a separate bus channel (chat-runner
  // drains them with subscribeOpStream and yields `{ type: "stream", delta }`
  // SSE events). Tool start/end/progress events already reach options.onEvent
  // through the chat-tool-dispatcher → executeToolCalls bridge, but stream
  // chunks have no equivalent path on this runner. Without this bridge the
  // sub-agent's live text doesn't reach handler:agent-output and the AGENTS
  // sidebar sits silent during a spawned agent's reply (P4.C4 finding).
  const offStream = options.onEvent
    ? subscribeOpStream(op.id, (chunk) => {
        const c = chunk as { delta?: string; replace?: boolean; text?: string } | null;
        if (c?.replace === true) {
          options.onEvent!({ type: "stream", replace: true, text: c.text ?? "" });
          return;
        }
        const delta = c?.delta;
        if (typeof delta !== "string" || delta.length === 0) return;
        options.onEvent!({ type: "stream", delta });
      })
    : () => {};

  // Wall-clock-ceiling timer: kicks opCancel after wallClockMs. Routes
  // through canonical's signal path so the op transitions running →
  // cancelling → cancelled. No outside-the-loop AbortController.
  let wallClockFired = false;
  const wallClockTimer = setTimeout(() => {
    wallClockFired = true;
    logger.warn(`[agent-runner] op ${op.id} hit wall-clock ceiling (${wallClockMs}ms) — issuing opCancel`);
    opCancel(op.id, "wall-clock-ceiling");
  }, wallClockMs);

  // External signal → opCancel. Preserves the cron service's existing
  // registerRunAbort interface for cancel-from-API while routing the
  // actual abort through canonical instead of the AbortController bypass.
  const onSignalAbort = () => {
    logger.info(`[agent-runner] op ${op.id} received external abort signal — issuing opCancel`);
    opCancel(op.id, "external-signal");
  };
  if (options.signal) {
    if (options.signal.aborted) onSignalAbort();
    else options.signal.addEventListener("abort", onSignalAbort);
  }

  try {
    canonicalLoopEntry(op, { sessionId });
    logger.info(`[agent-runner] submitted op ${op.id} type=${opType} lane=${lane} model=${options.model} wallClock=${wallClockMs}ms tools=${options.tools.length}`);

    while (terminal === null) {
      await new Promise<void>(r => { waiter = r; });
    }

    const messages = collectMessages(op.id, history, userMessage, options.systemPrompt);
    const stopReason = mapStopReason(terminal, errorCode);
    const result: AgentTurn = {
      messages,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason,
    };
    if (errorMessage && stopReason === "error") result.errorMessage = errorMessage;
    void wallClockFired;
    return result;
  } finally {
    clearTimeout(wallClockTimer);
    if (options.signal) options.signal.removeEventListener("abort", onSignalAbort);
    offEvents();
    offStream();
    cancelBridge.dispose();
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
  }
}

async function registerProviderAdapter(
  opId: string,
  options: CanonicalAgentOptions,
  sessionId: string,
): Promise<void> {
  const { provider, model, systemPrompt, temperature, apiKey } = options;

  if (provider === "anthropic") {
    registerAdapterForOp(opId, () =>
      createAnthropicAdapter({ systemPrompt, model, sessionId }),
    );
    return;
  }
  if (provider === "codex") {
    const { createCodexAdapter } = await import("./adapters/codex.js");
    registerAdapterForOp(opId, () =>
      createCodexAdapter({ systemPrompt, model, sessionId }),
    );
    return;
  }
  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("./adapters/openai-compat.js");
  let target = await resolveOpenAICompatTarget(provider, { apiKey, customBaseURL: options.baseURL });
  if (provider === "local") {
    const { isCloudModel, getCloudOllamaCallTarget } = await import("../ollama-cloud.js");
    if (isCloudModel(model)) {
      const cloudTarget = getCloudOllamaCallTarget();
      if (cloudTarget) target = cloudTarget;
    }
  }
  if (!target) {
    throw new Error(`provider ${provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  const finalTarget = target;
  registerAdapterForOp(opId, () =>
    createOpenAICompatAdapter({
      systemPrompt,
      model,
      baseURL: finalTarget.baseURL,
      apiKey: finalTarget.apiKey,
      temperature,
      sessionId,
    }),
  );
}

function seedOpMessages(
  opId: string,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  images: ImageAttachment[] | undefined,
): void {
  let seqInTurn = 0;
  const turnIdx = 0;

  for (const msg of history) {
    const role = chatRoleToCanonicalRole(msg.role);
    if (!role) continue;
    const text = extractTextContent(msg.content);

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

    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId) continue;

    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }
    if (role === "assistant" && toolCalls) {
      content = { text, toolCalls };
    }

    appendOpMessage({
      messageId: `hist-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId,
      turnIdx,
      seqInTurn,
      role,
      content,
      createdAt: new Date().toISOString(),
    });
    seqInTurn += 1;
  }

  // Mirror chat-runner.ts: image attachments ride on the seeded user-message
  // content payload. Adapters extract `images` and convert to the provider's
  // wire format (OpenAI multi-part / Anthropic image content blocks). Without
  // this, a vision-capable spawned agent (autopilot, delegation ack, etc.)
  // never sees the user's image — only the text describing it.
  const userContent: { text: string; images?: ImageAttachment[] } = { text: userMessage };
  if (images && images.length > 0) userContent.images = images;
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

function chatRoleToCanonicalRole(role: ChatCompletionMessageParam["role"]): CanonicalMessageRole | null {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool_result";
    case "system": return null;
    default: return null;
  }
}

function extractTextContent(content: ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!content || !Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map(p => p.text)
    .join("\n");
}

function collectMessages(
  opId: string,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  systemPrompt: string,
): ChatCompletionMessageParam[] {
  // Mirror legacy runAgent return shape: system + history + user + new
  // assistant/tool messages produced this run. Seeded rows are prefixed
  // `hist-*` / `um-*`; everything else is adapter-produced output we
  // need to project back to ChatCompletionMessageParam.
  const rows = readOpMessages(opId);
  const newMessages: ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    if (row.messageId.startsWith("hist-") || row.messageId.startsWith("um-")) continue;
    const m = opMessageRowToChatParam(row);
    if (m) newMessages.push(m);
  }
  return [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
    ...newMessages,
  ];
}

function mapStopReason(
  terminal: TerminalState,
  errorCode: string | undefined,
): AgentTurn["stopReason"] {
  if (terminal === "succeeded") return "end_turn";
  if (terminal === "cancelled") return "abort";
  if (errorCode === "max_turns_exceeded") return "max_iterations";
  return "error";
}
