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
 *      runtime (`tool-execution/`) — so canonical chat uses the SAME tool
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
import type { PreparedAgentRequest } from "../agent-request/types.js";
import type { ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";

import { canonicalLoopEntry } from "./index.js";
import { enableDefaultMiddlewareStack, getActiveMiddlewareStack } from "./middlewares/host.js";
import type { TerminalState } from "./terminal-states.js";
import { createLogger } from "../logger.js";

import { createChatOp } from "./chat-runner/create-op.js";
import { createChatLifecycle } from "./chat-runner/lifecycle.js";

export { opMessageRowToChatParam } from "./chat-runner/message-convert.js";

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

  const { op, wallClockMs, resolvedTarget } = await createChatOp(ctx);
  const lifecycle = await createChatLifecycle(op.id, ctx, resolvedTarget);
  const { pump } = lifecycle;
  const usageInputTokens = 0;
  const usageOutputTokens = 0;

  // 6. Submit — synchronous bookkeeping; loop runs on the scheduler.
  try {
    canonicalLoopEntry(op, { sessionId: ctx.sessionId });
    logger.info(`[chat-runner] submitted op ${op.id} sess=${ctx.sessionId.slice(0, 16)} model=${ctx.prepared.model} tools=${ctx.tools.length} wallClock=${wallClockMs}ms`);
    // Tell the UI the opId immediately so it can track for reconnect /
    // cancel — independent of any HTTP/SSE connection that may drop.
    pump.push({ type: "chat_op_started", opId: op.id });
  } catch (e) {
    yield { type: "error", message: `canonical chat submit failed: ${(e as Error).message}` };
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    lifecycle.dispose();
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
    lifecycle.dispose();
  }
}
