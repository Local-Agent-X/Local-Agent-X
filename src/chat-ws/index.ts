// WebSocket Chat System orchestrator.
//
// Replaces SSE for chat streaming. Benefits:
//  - Client can navigate away and reconnect — events are buffered
//  - Multiple chats can run simultaneously
//  - Stop/abort signal can be sent mid-stream
//  - Live indicators for active chats
//
// Protocol:
//   Client → Server: { type: "chat", sessionId, message, attachments? }
//   Client → Server: { type: "stop", sessionId }
//   Client → Server: { type: "subscribe", sessionId }
//   Client → Server: { type: "unsubscribe", sessionId }
//   Server → Client: { type: "event", sessionId, event: ServerEvent }
//   Server → Client: { type: "active_chats", sessionIds: string[] }

import type { Server } from "node:http";
import { createLogger } from "../logger.js";
import { serveOperatorSocket } from "../server/ws-operator-auth.js";
import { setupConnection } from "./connection-setup.js";
import { wireBridgeBroadcasters } from "./bridge-wiring.js";
import { attachMessageRouter } from "./message-router.js";
import { buildManager, type ChatWsManager } from "./manager.js";

const logger = createLogger("chat-ws");

export function setupChatWebSocket(server: Server, authToken: string, maxPayloadBytes: number): ChatWsManager {
  wireBridgeBroadcasters();

  serveOperatorSocket(server, { path: "/ws/chat", operatorToken: authToken, maxPayloadBytes, logger, tag: "chat-ws" }, (ws, req) => {
    const { subscriptions } = setupConnection(ws, { browser: !!req.headers.origin });
    // The operator/loopback connection gets no live-screen session — the screen
    // path runs over the broker transport, not this socket.
    attachMessageRouter({ ws, subscriptions, screen: null });
  });

  return buildManager();
}

export { announceChatListChanged, broadcastAll } from "./broadcast.js";
export type { ChatWsManager } from "./manager.js";
