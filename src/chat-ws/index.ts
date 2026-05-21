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

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { createLogger } from "../logger.js";
import { extractAuthToken, verifyToken } from "./auth.js";
import { setupConnection } from "./connection-setup.js";
import { wireBridgeBroadcasters } from "./bridge-wiring.js";
import { attachMessageRouter } from "./message-router.js";
import { buildManager, type ChatWsManager } from "./manager.js";

const logger = createLogger("chat-ws");

export function setupChatWebSocket(server: Server, authToken: string): ChatWsManager {
  wireBridgeBroadcasters();

  // noServer + manual upgrade routing so we can coexist with other
  // WebSocketServers on the same http server. The {server, path} mode
  // unconditionally aborts upgrades whose path doesn't match, which
  // prevents voice-ws and future WS endpoints from attaching cleanly.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname !== "/ws/chat") return;
      wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (e) {
      logger.warn(`[chat-ws] upgrade error: ${(e as Error).message}`);
      try { socket.destroy(); } catch {}
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const token = extractAuthToken(req);
    if (!verifyToken(token, authToken)) {
      ws.close(4001, "Unauthorized");
      return;
    }
    const { subscriptions } = setupConnection(ws);
    attachMessageRouter({ ws, subscriptions });
  });

  return buildManager();
}

export { broadcastAll } from "./state.js";
export type { ChatWsManager } from "./manager.js";
