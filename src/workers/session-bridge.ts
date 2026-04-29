/**
 * Session bridge — routes op completion notifications back to the chat
 * session that originally submitted the op via op_submit_async.
 *
 * Flow:
 *   1. Chat agent calls op_submit_async → tool injects sessionId from
 *      args._sessionId, calls trackOpForSession(opId, sessionId), then
 *      submits the op (fire-and-forget) and returns immediately.
 *   2. Worker eventually finishes; pool.ts emits "op-result" on its bus.
 *   3. This bridge subscribes to op-result; on each event it looks up the
 *      submitting session and pushes a tool_progress-style ServerEvent
 *      back into that session's chat WS stream so the user sees the
 *      completion notification live (or on next subscribe via the
 *      ActiveChat event buffer).
 *
 * Why a separate module instead of doing this in tools.ts:
 *   - tools.ts callbacks scope to a single tool invocation. Once the
 *     agent's turn ends, the per-call _onEvent closure goes out of
 *     scope. We need a session-scoped, persistent subscription owned
 *     by the server, not the tool invocation.
 *   - Keeps chat-ws.ts decoupled from worker internals — the bridge is
 *     the single integration point.
 */

import type { ServerEvent } from "../types.js";
import type { OpEvent, OpResult } from "./types.js";
import { subscribeAllOpResults, subscribeAllOps } from "./pool.js";
import { pushPendingNotification } from "./pending-notifications.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.session-bridge");

// opId -> sessionId of the chat that submitted it
const opSession = new Map<string, string>();

// sessionId -> set of opIds it has submitted (for cleanup + listing)
const sessionOps = new Map<string, Set<string>>();

// opId -> original task text (so the pending-notification carries the
// original user prompt for the agent to reference on next turn)
const opTask = new Map<string, string>();

// The broadcaster the chat-ws layer registers. Lets us push events back
// without importing chat-ws here (would create a circular dep with
// server/index.ts startup ordering).
let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;

// Persistence callback — appends a completion notice as an assistant
// message to the session, so the user sees it on reload even if the live
// WS event was missed. Registered by the server during bootstrap.
let persister: ((sessionId: string, content: string) => void) | null = null;

let initialized = false;

/** Initialize the bridge. Idempotent — call once at server startup. */
export function initSessionBridge(): void {
  if (initialized) return;
  initialized = true;
  subscribeAllOpResults((result) => onOpResult(result));
  subscribeAllOps((event) => onOpEvent(event));
  logger.info("[session-bridge] initialized");
}

/**
 * Forward worker events as bg_op_progress lines so the AGENTS sidebar
 * card shows live progress instead of sitting blank until completion.
 */
function onOpEvent(event: OpEvent): void {
  const sessionId = opSession.get(event.opId);
  if (!sessionId || !broadcaster) return;

  // Render only the events that map to user-visible activity. Drop noisy
  // internal types (heartbeat-ish events). Keep tool calls + agent text +
  // status transitions — those are the bits a human glancing at the
  // sidebar card actually wants to see.
  let line: string | null = null;
  switch (event.type) {
    case "tool_call": {
      const tn = (event.payload as { toolName?: string })?.toolName || "tool";
      line = `→ ${tn}`;
      break;
    }
    case "tool_result": {
      const tn = (event.payload as { toolName?: string })?.toolName || "tool";
      const ok = (event.payload as { ok?: boolean })?.ok;
      line = `  ${ok === false ? "✗" : "✓"} ${tn}`;
      break;
    }
    case "agent_text": {
      const text = ((event.payload as { text?: string })?.text || "").trim();
      if (!text) return;
      line = text.slice(0, 200);
      break;
    }
    case "started":
      line = "▶ started";
      break;
    case "phase": {
      const name = (event.payload as { name?: string })?.name || "phase";
      line = `phase: ${name}`;
      break;
    }
    case "needs_input":
      line = "⏸ needs input";
      break;
    default:
      return;
  }

  if (!line) return;
  try {
    broadcaster(sessionId, { type: "bg_op_progress", opId: event.opId, line });
  } catch (e) {
    logger.warn(`[session-bridge] progress broadcast threw: ${(e as Error).message}`);
  }
}

/**
 * Register the function that pushes a ServerEvent into a chat session's
 * WS stream. Called once by chat-ws.ts during setupChatWebSocket.
 */
export function setSessionBroadcaster(fn: (sessionId: string, event: ServerEvent) => void): void {
  broadcaster = fn;
}

/** Register the persistence callback (server bootstrap). */
export function setSessionPersister(fn: (sessionId: string, content: string) => void): void {
  persister = fn;
}

/**
 * Tell the bridge that opId was submitted by sessionId. Optional task text
 * is captured so the agent's pending-notification on the next turn includes
 * the original user prompt for natural narration.
 */
export function trackOpForSession(opId: string, sessionId: string, task?: string): void {
  if (!sessionId) return;
  opSession.set(opId, sessionId);
  if (task) opTask.set(opId, task);
  let set = sessionOps.get(sessionId);
  if (!set) { set = new Set(); sessionOps.set(sessionId, set); }
  set.add(opId);
}

/** List opIds a session has submitted. Used by op_status when no opId given. */
export function listOpsForSession(sessionId: string): string[] {
  const set = sessionOps.get(sessionId);
  return set ? [...set] : [];
}

function onOpResult(result: OpResult): void {
  const sessionId = opSession.get(result.opId);
  if (!sessionId) return; // op wasn't submitted by a chat session (e.g. cron, autopilot, internal)

  // Drop the mapping now that the op is terminal
  opSession.delete(result.opId);
  // Don't drop from sessionOps — keep the history for op_status listing

  if (!broadcaster) {
    logger.warn(`[session-bridge] op ${result.opId} completed but no broadcaster registered — event dropped`);
    return;
  }

  // Use a dedicated bg_op_completed ServerEvent variant. tool_progress was
  // the wrong shape — the frontend's tool_progress handler updates an
  // EXISTING tool card; orphan events (no prior tool_start) drop silently.
  // Worse, the per-turn message handler that processes chat-body events
  // gets DETACHED on `done`, so events arriving after the chat-route
  // emitted its synthetic done would never render even with a card to
  // attach to. bg_op_completed is handled by the persistent global
  // chatWs.onmessage handler in chat.js, which works regardless of turn
  // boundaries and renders as a fresh assistant message.
  const summary = result.finalSummary?.slice(0, 400) || "(no summary)";
  const status = (result.status === "completed" || result.status === "failed" || result.status === "cancelled")
    ? result.status
    : "failed";

  // Push to pending-notifications queue so the agent narrates this on the
  // user's next turn (instead of injecting a synthetic "1-line ack" message
  // that the user knows isn't from the agent). The sidebar shows live
  // status; the chat narration happens naturally when the user replies.
  pushPendingNotification(sessionId, {
    opId: result.opId,
    status,
    summary: result.finalSummary || "(no summary)",
    filesChanged: result.filesChanged,
    task: opTask.get(result.opId) || "(unknown)",
    completedAt: Date.now(),
  });
  opTask.delete(result.opId);
  void persister; // kept for future callers that legitimately want disk persistence

  try {
    broadcaster(sessionId, {
      type: "bg_op_completed",
      opId: result.opId,
      status,
      summary,
      filesChanged: result.filesChanged.slice(0, 10),
    });
    logger.info(`[session-bridge] notified session=${sessionId} op=${result.opId} status=${result.status}`);
  } catch (e) {
    logger.warn(`[session-bridge] broadcaster threw: ${(e as Error).message}`);
  }
}
