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
import { isLoopbackOrigin } from "../server-utils.js";
import { extractAuthToken } from "./auth.js";
import { authorizeUpgrade, WS_UNAUTHORIZED } from "../server/ws-operator-auth.js";
import { setupConnection } from "./connection-setup.js";
import { wireBridgeBroadcasters } from "./bridge-wiring.js";
import { attachMessageRouter } from "./message-router.js";
import { buildManager, type ChatWsManager } from "./manager.js";

const logger = createLogger("chat-ws");

export function setupChatWebSocket(server: Server, authToken: string, maxPayloadBytes: number): ChatWsManager {
  wireBridgeBroadcasters();

  // noServer + manual upgrade routing so we can coexist with other
  // WebSocketServers on the same http server. The {server, path} mode
  // unconditionally aborts upgrades whose path doesn't match, which
  // prevents voice-ws and future WS endpoints from attaching cleanly.
  // maxPayload caps a single frame at the configured upload limit — without it
  // the ws default is 100 MiB, which the WS path would let through unbounded
  // even when the operator lowered the HTTP body cap.
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname !== "/ws/chat") return;
      // Reject cross-origin WS handshakes (cross-site WebSocket hijacking): a
      // browser always sends Origin, so a non-loopback Origin is a cross-site
      // page dialing our socket. Non-browser clients (incl. the broker chat
      // bridge connecting to loopback as the operator) send no Origin and still
      // face the operator-token check below. Mirrors the HTTP CORS posture.
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin)) { try { socket.destroy(); } catch {} return; }
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
    // Upgrade gate: the operator token only (loopback). Rejections carry an
    // actionable reason and a clean code; never a silent hang (constitution §7).
    const auth = authorizeUpgrade(token, authToken);
    if (!auth.ok) {
      ws.close(WS_UNAUTHORIZED, auth.reason || "Unauthorized");
      return;
    }
    const { subscriptions } = setupConnection(ws);
    // The operator/loopback connection gets no live-screen session — the screen
    // path runs over the broker transport, not this socket.
    attachMessageRouter({ ws, subscriptions, screen: null });
  });

  return buildManager();
}

export { broadcastAll } from "./state.js";
export type { ChatWsManager } from "./manager.js";
