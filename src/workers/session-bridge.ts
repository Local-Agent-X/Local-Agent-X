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
import type { OpResult } from "./types.js";
import { subscribeAllOpResults } from "./pool.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.session-bridge");

// opId -> sessionId of the chat that submitted it
const opSession = new Map<string, string>();

// sessionId -> set of opIds it has submitted (for cleanup + listing)
const sessionOps = new Map<string, Set<string>>();

// The broadcaster the chat-ws layer registers. Lets us push events back
// without importing chat-ws here (would create a circular dep with
// server/index.ts startup ordering).
let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;

let initialized = false;

/** Initialize the bridge. Idempotent — call once at server startup. */
export function initSessionBridge(): void {
  if (initialized) return;
  initialized = true;
  subscribeAllOpResults((result) => onOpResult(result));
  logger.info("[session-bridge] initialized");
}

/**
 * Register the function that pushes a ServerEvent into a chat session's
 * WS stream. Called once by chat-ws.ts during setupChatWebSocket.
 */
export function setSessionBroadcaster(fn: (sessionId: string, event: ServerEvent) => void): void {
  broadcaster = fn;
}

/**
 * Tell the bridge that opId was submitted by sessionId. Called from
 * op_submit_async (and from the sync op_submit sugar so its completion
 * still surfaces if the user reconnects to the session later).
 */
export function trackOpForSession(opId: string, sessionId: string): void {
  if (!sessionId) return;
  opSession.set(opId, sessionId);
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

  // Render as a tool_progress-shaped event so the existing chat UI renders
  // it inline without needing a new ServerEvent variant. The agent will
  // also see the corresponding ActiveChat buffer entry on its next turn,
  // so it can reference the result naturally.
  const statusLabel =
    result.status === "completed" ? "✓ completed" :
    result.status === "failed"    ? "✗ failed" :
    result.status === "cancelled" ? "⊘ cancelled" :
                                    result.status;
  const summary = result.finalSummary?.slice(0, 400) || "(no summary)";
  const message =
    `🤖 op ${result.opId} ${statusLabel}\n` +
    summary +
    (result.filesChanged.length > 0 ? `\nfiles: ${result.filesChanged.slice(0, 5).join(", ")}` : "");

  try {
    broadcaster(sessionId, {
      type: "tool_progress",
      toolName: "op_submit_async",
      message,
    });
    logger.info(`[session-bridge] notified session=${sessionId} op=${result.opId} status=${result.status}`);
  } catch (e) {
    logger.warn(`[session-bridge] broadcaster threw: ${(e as Error).message}`);
  }
}
