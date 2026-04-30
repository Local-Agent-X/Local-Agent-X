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
import { timingSafeEqual } from "node:crypto";
import { getApprovalManager } from "./approval-manager.js";
import { setSessionBroadcaster } from "./workers/session-bridge.js";
import { setIdleNudgeBroadcaster } from "./workers/idle-nudge.js";

import { createLogger } from "./logger.js";
const logger = createLogger("chat-ws");

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

// Chat handler — set by server to process WS chat messages
type ChatHandler = (sessionId: string, message: string, attachments: any[]) => void;
let chatHandler: ChatHandler | null = null;

export function setupChatWebSocket(server: Server, authToken: string) {
  // Register the broadcaster the workers/session-bridge uses to push op
  // completion notifications back into the chat session. Done here (not
  // in setup callers) so the bridge wiring is a single line tied to chat
  // WS lifetime.
  setSessionBroadcaster((sessionId, event) => {
    const chat = activeChats.get(sessionId);
    if (chat) chat.events.push(event);          // buffer for replay
    // The AGENTS sidebar is a GLOBAL surface — it shows ALL background
    // ops regardless of which session triggered them (web chat, Telegram,
    // WhatsApp, voice, autopilot, cron). Bridge-originated ops use
    // sessionIds like `tg-XXX` / `wa-XXX` which the local UI never
    // subscribes to, so per-session routing made them invisible. Route
    // bg_op_* events globally; everything else stays per-session.
    const isBgOpEvent =
      event.type === "bg_op_queued" ||
      event.type === "bg_op_started" ||
      event.type === "bg_op_progress" ||
      event.type === "bg_op_completed" ||
      event.type === "bg_op_nudge";
    if (isBgOpEvent) {
      broadcastAll({ type: "event", sessionId, event });
    } else {
      broadcastToSession(sessionId, event);     // per-session: streams, tool cards, done
    }
  });
  setIdleNudgeBroadcaster((sessionId, event) => {
    const chat = activeChats.get(sessionId);
    if (chat) chat.events.push(event);
    broadcastToSession(sessionId, event);
  });

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
    // Auth check: accept token via query param OR WebSocket subprotocol
    const url = new URL(req.url || "/", "http://localhost");
    let token = url.searchParams.get("token") || "";
    // Also check Sec-WebSocket-Protocol header: ['lax-auth', TOKEN].
    // Accept legacy "sax-auth" too so cached old chat.js sessions still
    // connect across the rebrand. Drop sax-auth support after a deprecation
    // window once browsers have refreshed.
    if (!token) {
      const protocols = req.headers["sec-websocket-protocol"] || "";
      const parts = protocols.split(",").map(s => s.trim());
      let authIdx = parts.indexOf("lax-auth");
      if (authIdx < 0) authIdx = parts.indexOf("sax-auth");
      if (authIdx >= 0 && parts[authIdx + 1]) {
        token = parts[authIdx + 1];
      }
    }
    const tokenBuf = Buffer.from(token);
    const authBuf = Buffer.from(authToken);
    if (tokenBuf.length !== authBuf.length || !timingSafeEqual(tokenBuf, authBuf)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Track this client
    const subscriptions = new Set<string>();
    clients.set(ws, subscriptions);

    // Auto-close WebSocket connections after 24 hours to force re-authentication
    const WS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const maxAgeTimer = setTimeout(() => {
      ws.close(4002, "Session expired — please reconnect");
    }, WS_MAX_AGE_MS);
    ws.on("close", () => clearTimeout(maxAgeTimer));

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

      if (type === "chat" && sessionId) {
        // Handle chat via WebSocket — trigger the chat handler directly.
        // Accept the message if there's text OR at least one attachment.
        // Image-only sends (paste-and-send with no typed caption) have
        // msg.message === "" and would silently drop without this guard.
        const _atts = (msg.attachments || []) as any[];
        const _msgText = typeof msg.message === "string" ? msg.message : "";
        if (!_msgText && _atts.length === 0) {
          logger.warn(`[ws-chat] dropping empty chat from sess=${sessionId} (no text and no attachments)`);
        } else {
          const _imgCount = _atts.filter(a => a?.isImage).length;
          logger.info(`[ws-chat] recv sess=${sessionId} msg_len=${_msgText.length} atts=${_atts.length} imgs=${_imgCount} handler=${chatHandler ? "set" : "null"}`);
          subscriptions.add(sessionId);
          if (chatHandler) {
            chatHandler(sessionId, _msgText, _atts);
          }
        }
      }

      // Agent redirect: forward to Handler
      if (type === "agent-redirect" && msg.agentId && msg.instruction) {
        try {
          const { Handler } = require("./agency/handler.js");
          const handler = Handler.getInstance();
          handler.redirectAgent(String(msg.agentId), String(msg.instruction));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: `Redirect failed: ${e}` }));
        }
      }

      // Approval response: resolve a pending tool approval
      if (type === "approval_response" && msg.approvalId) {
        try {
          const resolved = getApprovalManager().resolveApproval(
            String(msg.approvalId),
            Boolean(msg.approved),
            Boolean(msg.rememberForSession),
          );
          if (!resolved) {
            ws.send(JSON.stringify({ type: "error", message: `Unknown or expired approval: ${msg.approvalId}` }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: `Approval response failed: ${e}` }));
        }
      }

      // Agent control: pause/resume/cancel
      if (type === "agent-control" && msg.agentId && msg.action) {
        try {
          const { Handler } = require("./agency/handler.js");
          const handler = Handler.getInstance();
          const agentId = String(msg.agentId);
          switch (msg.action) {
            case "pause":  handler.pauseAgent(agentId); break;
            case "resume": handler.resumeAgent(agentId); break;
            case "cancel": handler.cancelAgent(agentId); break;
            default:
              ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${msg.action}` }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: `Agent control failed: ${e}` }));
        }
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

          // Mark done only on real completion — non-terminal errors should not end the chat
          if (event.type === "done") {
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
     * Stop a chat by session ID (used by the HTTP fallback when WS is unavailable).
     * Returns true if the chat was active and aborted.
     */
    stopChat(sessionId: string): boolean {
      const chat = activeChats.get(sessionId);
      if (chat && !chat.done) {
        chat.abortController.abort();
        broadcastToSession(sessionId, { type: "error", message: "Stopped by user" });
        broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        chat.done = true;
        broadcastActiveChats();
        return true;
      }
      return false;
    },

    /**
     * Get list of active (in-progress) chat session IDs.
     */
    getActiveChats(): string[] {
      return [...activeChats.keys()].filter(id => !activeChats.get(id)!.done);
    },

    /**
     * Force-terminate a chat with an error reason. Used by transport-level
     * error handlers (e.g. wireWsChat self-loop fetch failure) so the WS
     * client gets a terminal signal instead of waiting for the 5-minute
     * cleanup timer.
     */
    failChat(sessionId: string, errorMessage: string): void {
      const chat = activeChats.get(sessionId);
      if (!chat || chat.done) return;
      broadcastToSession(sessionId, { type: "error", message: errorMessage });
      broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
      chat.done = true;
      broadcastActiveChats();
    },

    /** Register the handler for WS-initiated chat messages */
    onChat(handler: ChatHandler) {
      chatHandler = handler;
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
