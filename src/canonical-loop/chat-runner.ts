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
 *   3. Registers a per-op adapter (Anthropic / Codex / OpenAI-compat) using
 *      the prepared system prompt and model
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
 *
 * Helpers split into ./chat-runner/* — this file is the orchestrator.
 */
import { newOpId, writeOp } from "../ops/op-store.js";
import { buildContextPack } from "../ops/context-pack-builder.js";
import { getRetryPolicy } from "../ops/heartbeat.js";
import { trackOpForSession } from "../ops/session-bridge.js";
import type { Op, OpVisibility } from "../ops/types.js";
import type { PreparedAgentRequest } from "../agent-request/types.js";
import type { ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";

import { canonicalLoopEntry } from "./index.js";
import {
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
  registerToolsForOp,
  unregisterToolsForOp,
  registerOpBaselineTokens,
  unregisterOpBaselineTokens,
} from "./runtime.js";
import { estimateTokens } from "../context-manager/token-estimation.js";
import { isAnthropicModel } from "../context-manager/effective-window.js";
import { enableDefaultMiddlewareStack, getActiveMiddlewareStack } from "./middlewares/host.js";
import { opCancel } from "./control-api.js";
import { bridgeOpCancelToToolSignal } from "./cancel-handler.js";
import { makeChatToolDispatcher } from "./chat-tool-dispatcher.js";
import type { TerminalState } from "./terminal-states.js";
import { createLogger } from "../logger.js";

import { seedOpMessages } from "./chat-runner/seed-messages.js";
import { registerAdapterForChat } from "./chat-runner/register-adapter.js";
import { createEventPump } from "./chat-runner/event-pump.js";

export { opMessageRowToChatParam } from "./chat-runner/message-convert.js";

const logger = createLogger("canonical-loop.chat-runner");

// Absolute wall-clock backstop for a chat turn — NOT the stuck-detector. A
// genuinely stuck/hung agent is caught by the idle watchdog (turn-loop, 600s
// no-progress, resets on every adapter report) and a looping one by the
// repeat-failure / loop-detection / dead-end middlewares + MAX_TURNS. Those let
// work that keeps streaming run as long as it needs (legit agentic builds run
// tens of minutes). This ceiling only bounds a pathological turn that somehow
// emits forever without idling or looping. Generous by design: 2h default,
// override via LAX_CHAT_WALLCLOCK_MS, set 0 to disable (worker arms the timer
// only when > 0). Was a hard 5 min, which guillotined healthy long turns.
function readChatWallClockMs(): number {
  const raw = parseInt(process.env.LAX_CHAT_WALLCLOCK_MS ?? "7200000", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 7_200_000;
}

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
  const chatWallClockMs = readChatWallClockMs();
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
    authSource: ctx.prepared.authSource,
    budget: { maxIterations: ctx.prepared.maxIterations || 30, maxWallTimeMs: chatWallClockMs },
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
    model: ctx.prepared.model,
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
  await registerAdapterForChat(op.id, ctx.prepared, ctx.sessionId);

  // 4. Per-op tool dispatcher — wraps tool-executor with this turn's
  //    security context. Cleaned up in `finally` below. The bridge wires
  //    canonical opCancel into the tool layer so Stop kills subprocesses
  //    (self_edit's claude -p, build_app's codex --full-auto) instead of
  //    leaving them running while the op state hangs in `cancelling`.
  const cancelBridge = bridgeOpCancelToToolSignal(op.id, ctx.signal);

  // External abort → opCancel. Mirrors agent-runner.ts. Without this the
  // tool-layer bridge above kills subprocesses but the LLM stream itself
  // keeps reading until the provider client's own backstop (Codex's 90s
  // silence timeout) fires. opCancel routes through cancel-handler.ts
  // which calls adapter.abort() — that aborts the in-flight stream
  // immediately. Idempotent if opCancel was already issued.
  let externalAbortListener: (() => void) | null = null;
  if (ctx.signal) {
    externalAbortListener = () => {
      logger.info(`[chat-runner] op ${op.id} received external abort signal — issuing opCancel`);
      opCancel(op.id, "external-signal");
    };
    if (ctx.signal.aborted) externalAbortListener();
    else ctx.signal.addEventListener("abort", externalAbortListener, { once: true });
  }

  registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
    tools: ctx.tools,
    security: ctx.security,
    toolPolicy: ctx.toolPolicy,
    threatEngine: ctx.threatEngine,
    rbac: ctx.rbac,
    callerRole: ctx.callerRole,
    sessionId: ctx.sessionId,
    callContext: "local",
    opId: op.id,
    onEvent: ctx.onToolEvent,
    signal: cancelBridge.signal,
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

  // Baseline token cost of everything the adapter sends OUTSIDE the message
  // history — the system prompt (which also carries injected memory + the
  // deferred-tool name manifest) plus the loaded tool schemas. Static for the
  // op's life, so compute once here; the compaction gate adds it as a floor
  // when it has no real-usage anchor, so chat sizing reflects the real ~147k+
  // request instead of just the conversation. See build-input.ts / status.ts.
  //
  // Scoped to Anthropic models: that's where the tight ~200k CLI window makes
  // the baseline decisive. Codex/Gemini thresholds (25/35/55) were calibrated
  // against the baseline-BLIND estimate, so feeding them the real baseline
  // without re-tuning would over-compact — a separate follow-up. Non-Anthropic
  // ops simply register nothing → getOpBaselineTokens returns 0 → unchanged.
  //
  // estimateTokens (chars/3.5) over-counts JSON schemas somewhat vs the real
  // tokenizer — deliberately kept (same estimator as message sizing) because it
  // errs high, the SAFE direction: over-count compacts a touch early, never
  // under-sizes into an over-window "prompt too long". The window is baseline-
  // dominated regardless (~147k/200k), so precise tool-token accuracy only
  // shifts conversation headroom; the real relief is shrinking the manifest.
  if (isAnthropicModel(ctx.prepared.model)) {
    registerOpBaselineTokens(
      op.id,
      estimateTokens(ctx.prepared.systemPrompt) + estimateTokens(JSON.stringify(toolDescriptors)),
    );
  }

  // 5. Subscribe BEFORE submitting so we don't miss the synchronous
  //    `state_changed: queued` event that canonicalLoopEntry emits.
  const pump = createEventPump(op.id);
  const usageInputTokens = 0;
  const usageOutputTokens = 0;

  // 6. Submit — synchronous bookkeeping; loop runs on the scheduler.
  try {
    canonicalLoopEntry(op, { sessionId: ctx.sessionId });
    logger.info(`[chat-runner] submitted op ${op.id} sess=${ctx.sessionId.slice(0, 16)} model=${ctx.prepared.model} tools=${ctx.tools.length} wallClock=${chatWallClockMs}ms`);
    // Tell the UI the opId immediately so it can track for reconnect /
    // cancel — independent of any HTTP/SSE connection that may drop.
    pump.push({ type: "chat_op_started", opId: op.id });
  } catch (e) {
    yield { type: "error", message: `canonical chat submit failed: ${(e as Error).message}` };
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    pump.dispose();
    cancelBridge.dispose();
    if (externalAbortListener && ctx.signal) ctx.signal.removeEventListener("abort", externalAbortListener);
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
    unregisterOpBaselineTokens(op.id);
    return;
  }

  // 7. Drain events until terminal.
  let terminal: TerminalState | null = null;
  try {
    while (terminal === null) {
      const pulled = await pump.pull();
      for (const ev of pulled.events) yield ev;
      terminal = pulled.terminal;
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
    pump.dispose();
    cancelBridge.dispose();
    if (externalAbortListener && ctx.signal) ctx.signal.removeEventListener("abort", externalAbortListener);
    unregisterToolDispatcherForOp(op.id);
    unregisterToolsForOp(op.id);
    unregisterOpBaselineTokens(op.id);
  }
}
