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
import { setSessionBroadcaster } from "./ops/session-bridge.js";
import { setIdleNudgeBroadcaster } from "./ops/idle-nudge.js";

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
  // Register the broadcaster the ops/session-bridge uses to push op
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

    // Replay bg_op_started for any currently-running autopilot ops so
    // a fresh page load (or post-restart reconnect) sees the AGENTS card
    // for runs that started before this WS connection. Without this, an
    // autopilot launched at T0, server restarted at T1, browser reconnected
    // at T2 = the user has no visibility into the live autopilot until it
    // emits its next bg_op_progress (which could be 5+ minutes away).
    void (async () => {
      try {
        const { listActiveAutopilotOps } = await import("./autopilot/loop.js");
        for (const op of listActiveAutopilotOps()) {
          // Match the worker pool's broadcast envelope so chat.js's
          // msg.event.type handler fires. Earlier I sent
          // { type: "broadcast", event: ... } which no handler matched.
          ws.send(JSON.stringify({
            type: "event",
            sessionId: "autopilot",  // chat.js requires truthy sessionId
            event: {
              type: "bg_op_started",
              opId: op.id,
              task: op.autopilot?.topic || "Autopilot",
              provider: "autopilot",
            },
          }));
        }
      } catch { /* autopilot module not loadable — skip silently */ }
    })();

    ws.on("message", async (data: Buffer) => {
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

      // Reconnect to a canonical op's event stream after a connection drop.
      // The client tracks `opId` from the `chat_op_started` event and the
      // last canonical `seq` it observed; on WS reconnect it sends this
      // message to replay missed events and re-attach to the live tail.
      // Stream chunks during the disconnect window are NOT replayed (they
      // are ephemeral by design); the assistant's finalized message text
      // arrives via canonical `message_appended` events whose payload
      // points at op_messages on disk. Net UX: connection drops become
      // a brief visual pause rather than a lost response.
      if (type === "reconnect_op" && sessionId && typeof msg.opId === "string") {
        const opId = msg.opId;
        const sinceSeq = typeof msg.sinceSeq === "number" ? msg.sinceSeq : -1;
        try {
          const { reconnectOp, OP_EVENTS_FROM_BEGINNING, readOpMessages } =
            await import("./canonical-loop/index.js");
          const result = await reconnectOp(opId, sinceSeq < 0 ? OP_EVENTS_FROM_BEGINNING : sinceSeq, (event) => {
            // Translate canonical events to chat ServerEvents and send
            // ONLY to this WS (not broadcast — other connections didn't
            // ask for this replay). The session-bridge-observer handles
            // ongoing live broadcasts to all session subscribers.
            const b = (event.body ?? {}) as Record<string, unknown>;
            if (event.type === "state_changed") {
              const to = b.to as string | undefined;
              if (to === "succeeded" || to === "failed" || to === "cancelled") {
                ws.send(JSON.stringify({
                  type: "event",
                  sessionId,
                  event: { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
                  _opId: opId,
                  _seq: event.seq,
                }));
              }
            } else if (event.type === "error") {
              const code = (b.code as string | undefined) ?? "error";
              const message = (b.message as string | undefined) ?? "";
              ws.send(JSON.stringify({
                type: "event",
                sessionId,
                event: { type: "error", message: `${code}${message ? ": " + message.slice(0, 240) : ""}` },
                _opId: opId,
                _seq: event.seq,
              }));
            }
          });
          // Send the assistant's finalized text from op_messages (the
          // stream chunks are gone but the persisted assistant message
          // contains the full reply).
          if (result.ok) {
            try {
              const messages = readOpMessages(opId);
              for (const m of messages) {
                if (m.role !== "assistant") continue;
                const content = m.content as { text?: unknown } | null | undefined;
                const text = typeof content?.text === "string" ? content.text : "";
                if (text) {
                  ws.send(JSON.stringify({
                    type: "event",
                    sessionId,
                    event: { type: "stream", delta: text },
                    _opId: opId,
                    _replay: true,
                  }));
                }
              }
            } catch { /* best-effort replay */ }
          } else {
            ws.send(JSON.stringify({
              type: "error",
              message: `reconnect_op failed: ${result.code} ${result.message}`,
            }));
          }
          // Detach the live subscription when WS closes.
          if (result.ok) ws.on("close", result.off);
        } catch (e) {
          logger.warn(`[ws-chat] reconnect_op error: ${(e as Error).message}`);
        }
        return;
      }

      // Cancel a running canonical op (chat or worker delegation). The
      // canonical control API handles the queued→cancelled / running→
      // cancelling→cancelled transitions cleanly, including aborting the
      // adapter's in-flight request and signaling the warm-pool to kill
      // the CLI process (via the "stop" reason matching).
      if (type === "cancel_op" && typeof msg.opId === "string") {
        const opId = msg.opId;
        try {
          const { opCancel } = await import("./canonical-loop/index.js");
          const result = opCancel(opId, "user-stop");
          if (!result.ok) {
            logger.warn(`[ws-chat] cancel_op ${opId} failed: ${result.code} ${result.message}`);
          } else {
            logger.info(`[ws-chat] cancel_op ${opId} → success`);
          }
        } catch (e) {
          logger.warn(`[ws-chat] cancel_op error: ${(e as Error).message}`);
        }
        return;
      }

      if (type === "stop" && sessionId) {
        const chat = activeChats.get(sessionId);
        if (chat && !chat.done) {
          chat.abortController.abort();
          // Also release the turn lock so the user can immediately send a new
          // message. Without this the next message hits "Your previous request
          // is still running" because the lock waits for the agent's finally
          // block to free it — which can take 60+ seconds if a subprocess
          // stalls. Stop should mean stop, not "stop and wait."
          try {
            const { abortTurn, releaseTurn } = await import("./session-turn-lock.js");
            abortTurn(sessionId);
            releaseTurn(sessionId);
          } catch (e) {
            logger.warn(`[ws-chat] stop: turn-lock release failed: ${(e as Error).message}`);
          }
          broadcastToSession(sessionId, { type: "error", message: "Stopped by user" });
          broadcastToSession(sessionId, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
          chat.done = true;
          broadcastActiveChats();
        }
      }

      // Step 4: user typed during an in-flight turn — push into the
      // session's inject queue. The interjectDrainMiddleware picks it
      // up at the start of the next iteration so the agent sees the
      // message inline. Bypasses the turn-lock entirely (lock guards
      // "start NEW turn"; inject is "tack onto EXISTING turn").
      if (type === "inject" && sessionId && typeof msg.message === "string" && msg.message.trim()) {
        try {
          const { pushInject } = await import("./agent-loop/inject-queue.js");
          pushInject(sessionId, msg.message.trim());
          logger.info(`[ws-chat] inject sess=${sessionId} len=${msg.message.length}`);
        } catch (e) {
          logger.warn(`[ws-chat] inject failed: ${(e as Error).message}`);
        }
        return;
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
          // Stamp the chat's current project onto the session so agent_*
          // tool calls auto-scope. The frontend includes projectId on
          // each chat message when the chat is nested under a project.
          try {
            const { setSessionProject } = await import("./session-project.js");
            setSessionProject(sessionId, typeof msg.projectId === "string" ? msg.projectId : null);
          } catch (e) {
            logger.warn(`[ws-chat] failed to set session project: ${(e as Error).message}`);
          }
          subscriptions.add(sessionId);
          if (chatHandler) {
            chatHandler(sessionId, _msgText, _atts);
          }
        }
      }

      // Agent redirect — route by id prefix (mirrors the agent-control
      // handler's three-way split below).
      //   - op_*     → worker-pool op, use pool.redirectOp (cooperative
      //                inject — worker reads at next safe boundary)
      //   - agent-*  → legacy Handler.redirectAgent
      // Live failure before this fix: the handler used Handler unconditionally
      // for both id shapes. op_* redirects silently no-opped because Handler
      // doesn't track worker-pool ids — the user typed a redirect, hit Enter,
      // saw nothing happen, and the worker kept doing the wrong thing.
      // (Bonus: the previous version also used `require()` in this ESM file,
      // which throws — every redirect attempt landed in the catch and sent
      // a generic "Redirect failed" error toast.)
      if (type === "agent-redirect" && msg.agentId && msg.instruction) {
        try {
          const agentId = String(msg.agentId);
          const instruction = String(msg.instruction);
          if (agentId.startsWith("op_")) {
            const { opRedirect } = await import("./canonical-loop/index.js");
            const res = opRedirect(agentId, instruction, "user");
            if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not running (cannot redirect)` }));
          } else {
            const { Handler } = await import("./agency/handler.js");
            const handler = Handler.getInstance();
            handler.redirectAgent(agentId, instruction);
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: `Redirect failed: ${(e as Error).message}` }));
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
      // The AGENTS sidebar shows three kinds of cards:
      //   - Autopilot ops — id like "op_ap_XXX"  (separate lifecycle, stop only)
      //   - Canonical-loop ops — id like "op_freeform_XXX" (control-api)
      //   - Legacy sub-agents (Handler/agency system) — id like "agent-XXX"
      if (type === "agent-control" && msg.agentId && msg.action) {
        try {
          const agentId = String(msg.agentId);
          // Route by id prefix. Three id shapes coexist in the AGENTS sidebar:
          //   - op_ap_*  → autopilot ops (separate lifecycle, has stop endpoint)
          //   - op_*     → canonical-loop ops (opCancel / opPause / opResume)
          //   - agent-*  → legacy Handler sub-agents
          // Earlier bug: op_ap_* matched the op_* branch and silently no-opped
          // because pool.killOp didn't know about autopilot ops; the comment
          // is preserved here as a guardrail — the prefix check still matters
          // even with the unified canonical surface.
          if (agentId.startsWith("op_ap_")) {
            // Autopilot — only "stop" is supported (v1 scope per spec).
            // Pause/cancel/resume all map to stop because autopilot doesn't
            // have cooperative pause-mid-round semantics. Stop ends the run
            // gracefully (current round finishes, then exits).
            const { requestStop } = await import("./autopilot/loop.js");
            try {
              const result = requestStop(agentId);
              if (!result) ws.send(JSON.stringify({ type: "error", message: `Autopilot ${agentId} not active (already finished or unknown)` }));
              else if (msg.action === "pause" || msg.action === "resume") {
                ws.send(JSON.stringify({ type: "error", message: `Autopilot doesn't support pause/resume — sent stop instead. Run will end after current round.` }));
              }
            } catch (e) {
              ws.send(JSON.stringify({ type: "error", message: `Autopilot stop failed: ${(e as Error).message}` }));
            }
          } else if (agentId.startsWith("op_")) {
            // op_* IDs are all canonical-loop ops (op_chat_turn,
            // op_voice_turn, op_research, delegations from
            // op_submit_async, etc.). Cancel routes through the canonical
            // control API.
            const { opCancel, opPause, opResume } = await import("./canonical-loop/index.js");
            switch (msg.action) {
              case "cancel": {
                const res = opCancel(agentId, "user-stop");
                if (!res.ok) {
                  ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not found (already finished)` }));
                }
                break;
              }
              case "pause": {
                const res = opPause(agentId, "user");
                if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `pause failed: ${res.code}` }));
                break;
              }
              case "resume": {
                const res = opResume(agentId, "user");
                if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `resume failed: ${res.code}` }));
                break;
              }
            }
          } else {
            // Legacy sub-agent — route to Handler
            const { Handler } = await import("./agency/handler.js");
            const handler = Handler.getInstance();
            switch (msg.action) {
              case "pause":  handler.pauseAgent(agentId); break;
              case "resume": handler.resumeAgent(agentId); break;
              case "cancel": handler.cancelAgent(agentId); break;
              default:
                ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${msg.action}` }));
            }
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
          // If this turn was already stopped (user pressed Stop, or `done`
          // already emitted), drop any further events. Provider streams can
          // keep flushing buffered tokens for a brief window after the abort
          // signal — without this guard those stale deltas leak into the
          // next turn on the same session and overwrite the new response.
          if (chat.done) return;

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
        // Release the turn lock so the next message isn't rejected with
        // "previous request still running". The HTTP /api/chats/stop already
        // calls abortTurn separately; this gives the WS path the same
        // behavior + adds releaseTurn so the user can send immediately.
        // Fire-and-forget — if it throws we still want stop to return true.
        void (async () => {
          try {
            const { abortTurn, releaseTurn } = await import("./session-turn-lock.js");
            abortTurn(sessionId);
            releaseTurn(sessionId);
          } catch (e) {
            logger.warn(`[stopChat] turn-lock release failed: ${(e as Error).message}`);
          }
        })();
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

    /**
     * Push a one-off event to WS subscribers of `sessionId` outside the
     * per-chat onEvent channel (which only exists between startChat and
     * `done`). Used for pre-turn telemetry like `context_status` that the
     * old code path emitted via `emitSse` only — WS clients never saw it
     * because emitSse is null on the WS transport (see run-chat-turn.ts).
     * Returns false if no WS clients are subscribed; caller falls back.
     */
    emit(sessionId: string, event: ServerEvent): void {
      broadcastToSession(sessionId, event);
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
