/**
 * WebSocket Chat System
 *
 * Replaces SSE for chat streaming. Benefits:
 * - Client can navigate away and reconnect — events are buffered
 * - Multiple chats can run simultaneously
 * - Stop/abort signal can be sent mid-stream
 * - Live indicators for active chats
 *
 * Protocol:
 *   Client → Server: { type: "chat", sessionId, message, attachments? }
 *   Client → Server: { type: "stop", sessionId }
 *   Client → Server: { type: "subscribe", sessionId }  // watch an existing chat
 *   Client → Server: { type: "unsubscribe", sessionId }
 *   Server → Client: { type: "event", sessionId, event: ServerEvent }
 *   Server → Client: { type: "active_chats", sessionIds: string[] }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { ServerEvent } from "./types.js";

interface ActiveChat {
  sessionId: string;
  events: ServerEvent[];       // Buffered events for replay
  abortController: AbortController;
  startedAt: number;
  done: boolean;
}

// Active chats — keyed by sessionId
const activeChats = new Map<string, ActiveChat>();

// Connected clients — each client subscribes to sessionIds
const clients = new Map<WebSocket, Set<string>>();

export function setupChatWebSocket(server: Server, authToken: string) {
  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // Auth check via query param
    const url = new URL(req.url || "/", "http://localhost");
    const token = url.searchParams.get("token") || "";
    if (token !== authToken) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Track this client
    const subscriptions = new Set<string>();
    clients.set(ws, subscriptions);

    // Send list of currently active chats
    ws.send(JSON.stringify({
      type: "active_chats",
      sessionIds: [...activeChats.keys()].filter(id => !activeChats.get(id)!.done),
    }));

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = msg.type as string;
      const sessionId = msg.sessionId as string;

      if (type === "subscribe" && sessionId) {
        // Subscribe to a chat — replay buffered events
        subscriptions.add(sessionId);
        const chat = activeChats.get(sessionId);
        if (chat) {
          // Replay all buffered events
          for (const event of chat.events) {
            ws.send(JSON.stringify({ type: "event", sessionId, event }));
          }
        }
      }

      if (type === "unsubscribe" && sessionId) {
        subscriptions.delete(sessionId);
      }

      if (type === "stop" && sessionId) {
        const chat = activeChats.get(sessionId);
        if (chat && !chat.done) {
          chat.abortController.abort();
          broadcastToSession(sessionId, { type: "error", message: "Stopped by user" });
          broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
          chat.done = true;
          broadcastActiveChats();
        }
      }

      if (type === "chat" && sessionId && msg.message) {
        // Chat request handled externally — this is just the signaling layer
        // The actual chat is triggered via the existing /api/chat endpoint
        // but we register the client's subscription
        subscriptions.add(sessionId);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  return {
    /**
     * Register an active chat. Called when /api/chat starts processing.
     */
    startChat(sessionId: string): { abort: AbortController; onEvent: (event: ServerEvent) => void } {
      const abortController = new AbortController();
      const chat: ActiveChat = {
        sessionId,
        events: [],
        abortController,
        startedAt: Date.now(),
        done: false,
      };
      activeChats.set(sessionId, chat);
      broadcastActiveChats();

      return {
        abort: abortController,
        onEvent(event: ServerEvent) {
          // Buffer the event
          chat.events.push(event);

          // Limit buffer size (keep last 500 events)
          if (chat.events.length > 500) {
            chat.events = chat.events.slice(-400);
          }

          // Broadcast to all subscribed clients
          broadcastToSession(sessionId, event);

          // Mark done on completion
          if (event.type === "done" || event.type === "error") {
            chat.done = true;
            // Clean up after 5 minutes
            setTimeout(() => {
              activeChats.delete(sessionId);
              broadcastActiveChats();
            }, 5 * 60 * 1000);
            broadcastActiveChats();
          }
        },
      };
    },

    /**
     * Check if a chat has an abort signal pending.
     */
    getAbortSignal(sessionId: string): AbortSignal | undefined {
      return activeChats.get(sessionId)?.abortController.signal;
    },

    /**
     * Get list of active (in-progress) chat session IDs.
     */
    getActiveChats(): string[] {
      return [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
    },
  };
}

function broadcastToSession(sessionId: string, event: ServerEvent) {
  const payload = JSON.stringify({ type: "event", sessionId, event });
  for (const [ws, subs] of clients) {
    if (subs.has(sessionId) && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastActiveChats() {
  const activeIds = [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
  const payload = JSON.stringify({ type: "active_chats", sessionIds: activeIds });
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/** Broadcast a message to ALL connected WebSocket clients (for agent events). */
function broadcastAll(data: Record<string, unknown>) {
  const payload = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export { broadcastAll };
export type ChatWsManager = ReturnType<typeof setupChatWebSocket>;
