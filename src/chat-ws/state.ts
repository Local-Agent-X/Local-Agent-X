// Shared chat-ws state: active sessions, connected clients, the chat
// handler hook, and the broadcast helpers that operate over both.
//
// Single source of truth for who's connected and who's listening to
// which sessionId. Other chat-ws modules import from here rather than
// passing closures around.

import type { WebSocket } from "ws";
import type { ServerEvent } from "../types.js";

export interface ActiveChat {
  sessionId: string;
  events: ServerEvent[];       // Buffered events for replay
  abortController: AbortController;
  startedAt: number;
  done: boolean;
}

export type ChatHandler = (sessionId: string, message: string, attachments: unknown[]) => void;

// Active chats — keyed by sessionId.
export const activeChats = new Map<string, ActiveChat>();

// Connected clients — each client subscribes to sessionIds.
export const clients = new Map<WebSocket, Set<string>>();

// Chat handler — set by the server to process WS chat messages.
let chatHandler: ChatHandler | null = null;
export function setChatHandler(h: ChatHandler): void { chatHandler = h; }
export function getChatHandler(): ChatHandler | null { return chatHandler; }

// Message-count provider for the session_snapshot event. Wired from
// src/server/index.ts where SessionStore is in scope; the chat-ws layer
// doesn't import SessionStore directly to avoid a circular dependency.
let messageCountForSession: ((sessionId: string) => number) | null = null;
export function setMessageCountForSession(fn: (sessionId: string) => number): void {
  messageCountForSession = fn;
}
export function getMessageCountForSession(): ((sessionId: string) => number) | null {
  return messageCountForSession;
}

// Eval sessions (/api/eval/run) are dry-run throwaways that run a real chat
// turn purely to observe tool routing. They must never reach a browser:
// announcing one via active_chats makes the UI subscribe and render its
// streamed messages into the user's open chat. Filter them at the broadcast
// source so no client path can pick them up.
function isHeadlessSession(sessionId: string): boolean {
  return sessionId.startsWith("eval-");
}

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
  if (isHeadlessSession(sessionId)) return;
  const payload = JSON.stringify({ type: "event", sessionId, event });
  for (const [ws, subs] of clients) {
    if (subs.has(sessionId) && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

export function broadcastActiveChats(): void {
  const activeIds = [...activeChats.keys()].filter(id => !activeChats.get(id)!.done && !isHeadlessSession(id));
  const payload = JSON.stringify({ type: "active_chats", sessionIds: activeIds });
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

/** Broadcast a message to ALL connected WebSocket clients (for agent
 *  events that don't target a specific session). Used by app-tools,
 *  autopilot, routes/apps, routes/settings/* via dynamic import. */
export function broadcastAll(data: Record<string, unknown>): void {
  const payload = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

export interface TerminateOptions {
  /** Abort the in-flight provider stream + release the turn lock.
   *  `true` for user-initiated stop; `false` for transport-level failures
   *  where the orchestrator has already finished its side of the turn. */
  abort: boolean;
  /** Error message to broadcast before the terminal `done`. Empty string
   *  emits no error event (used by graceful-fail callers that only need
   *  the done). */
  errorMessage: string;
}

/**
 * Single source of truth for "this chat is over." Three former call sites
 * (manager.stopChat, manager.failChat, message-router.handleStop) had near-
 * identical bodies — every fix had to be made in three places. Consolidating
 * here means the next time we change termination semantics (e.g. dedup done,
 * add a reason code), it's one edit.
 *
 * Returns `true` iff the chat was live and we terminated it; `false` if the
 * session was unknown or already done.
 */
export function terminateChat(sessionId: string, opts: TerminateOptions): boolean {
  const chat = activeChats.get(sessionId);
  if (!chat || chat.done) return false;

  if (opts.abort) {
    chat.abortController.abort();
    void releaseTurnLockSafe(sessionId);
    void abortActiveSelfEditSafe(sessionId);
  }

  if (opts.errorMessage) {
    broadcastToSession(sessionId, { type: "error", message: opts.errorMessage });
  }
  broadcastToSession(sessionId, {
    type: "done",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  chat.done = true;
  broadcastActiveChats();
  return true;
}

async function releaseTurnLockSafe(sessionId: string): Promise<void> {
  try {
    const { abortTurn, releaseTurn } = await import("../session/turn-lock.js");
    abortTurn(sessionId);
    releaseTurn(sessionId);
  } catch {
    // best-effort: lock release failures don't change terminate semantics
  }
}

// Kill the live self_edit sandbox subprocesses immediately on user stop.
// Without this, abort propagates only through the canonical-loop signal and
// gets picked up at the next sandbox gate hop — leaving the chat marked done
// while claude -p keeps running for minutes inside the worktree.
async function abortActiveSelfEditSafe(sessionId: string): Promise<void> {
  try {
    const { abortActiveSelfEdit } = await import("../self-edit/session-lock.js");
    abortActiveSelfEdit(sessionId);
  } catch {
    // best-effort: lock module unreachable doesn't change terminate semantics
  }
}
