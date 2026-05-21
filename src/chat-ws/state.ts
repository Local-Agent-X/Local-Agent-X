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

export function broadcastToSession(sessionId: string, event: ServerEvent): void {
  const payload = JSON.stringify({ type: "event", sessionId, event });
  for (const [ws, subs] of clients) {
    if (subs.has(sessionId) && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

export function broadcastActiveChats(): void {
  const activeIds = [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
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
