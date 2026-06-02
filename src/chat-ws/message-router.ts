// Branches on msg.type from the WS client. Each handler is small enough
// to keep inline; splitting per-handler would scatter the routing
// without making any single branch easier to follow.
//
// Subscribe / unsubscribe mutate the per-connection subscription set;
// stop / reconnect_op / etc. operate on session-level state.

import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";
import { getApprovalManager } from "../approval-manager.js";
import {
  activeChats,
  broadcastToSession,
  getChatHandler,
  getMessageCountForSession,
  terminateChat,
} from "./state.js";
import { handleIdeRuntimeError } from "./ide-runtime-error.js";
// Static imports for the inject hot path. Previously these were `await
// import(...)` inside the handler, but every `await` yields the event loop
// and the worker's continuation guard (worker.ts:178) could run in between —
// observing an empty queue, exiting op1, and then the resumed handler would
// route the inject through getChatHandler() as a fresh op2, racing op1's
// persistTurnState and writing the inject to session.messages BEFORE the
// original question. Keeping the inject path fully synchronous closes the
// race: enqueue happens in one event-loop turn, the guard sees it.
import { listOpsForSession, hasChatHandlerPending } from "../ops/session-bridge.js";
import { pushInject } from "../agent-loop/inject-queue.js";

const logger = createLogger("chat-ws");

export interface RouterContext {
  ws: WebSocket;
  subscriptions: Set<string>;
}

export function attachMessageRouter(ctx: RouterContext): void {
  const { ws, subscriptions } = ctx;
  ws.on("message", async (data: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const type = msg.type as string;
    const sessionId = msg.sessionId as string;

    // JSON ping/pong — browser WS API doesn't expose protocol-level
    // ping frames, so the client sends {type:"ping"} and we echo
    // {type:"pong"} so it can detect half-open from its end too.
    if (type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch {}
      return;
    }

    if (type === "subscribe" && sessionId) {
      subscriptions.add(sessionId);
      const chat = activeChats.get(sessionId);
      if (chat) {
        for (const event of chat.events) {
          ws.send(JSON.stringify({ type: "event", sessionId, event }));
        }
      }
      // Session snapshot — late subscribers (page reload, leave-and-come-back,
      // WS reconnect after server restart) get the current truth so the
      // renderer can reconcile stale UI:
      //   - worker chips stuck on "working" because the terminal event went
      //     out while no one was listening
      //   - chat messages that landed on disk but never reached this client
      // The per-session `events` replay above only fires for sessions still
      // in `activeChats` (live op); once `activeChats.delete` runs at op
      // completion the buffer is gone. This snapshot is what closes that
      // gap — works whether the session is live or fully completed.
      try {
        const { listOpsForSession } = await import("../ops/session-bridge.js");
        const liveOpIds = listOpsForSession(sessionId);
        const countFn = getMessageCountForSession();
        const messageCount = countFn ? countFn(sessionId) : 0;
        ws.send(JSON.stringify({
          type: "session_snapshot",
          sessionId,
          liveOpIds,
          messageCount,
        }));
      } catch (e) {
        logger.warn(`[ws-chat] session_snapshot failed for ${sessionId}: ${(e as Error).message}`);
      }
      return;
    }

    if (type === "unsubscribe" && sessionId) {
      subscriptions.delete(sessionId);
      return;
    }

    if (type === "reconnect_op" && sessionId && typeof msg.opId === "string") {
      await handleReconnectOp(ws, sessionId, msg.opId, typeof msg.sinceSeq === "number" ? msg.sinceSeq : -1);
      return;
    }

    if (type === "stop" && sessionId) {
      handleStop(sessionId);
      return;
    }

    if (type === "inject" && sessionId && typeof msg.message === "string" && msg.message.trim()) {
      try {
        const text = msg.message.trim();
        const clientInjectId = typeof msg.injectId === "string" && msg.injectId ? msg.injectId : undefined;
        // Route as fresh turn ONLY when nothing is live AND no chat handler is
        // mid-prep for this session. The pending check closes a start-of-turn
        // race: client sends `chat` then types fast → inject arrives during
        // runChatTurn's ~30-200ms prep before the canonical op exists →
        // listOpsForSession returns [] even though the original turn is about
        // to start. Without `hasChatHandlerPending` the inject takes the
        // fresh-turn branch, broadcasts inject_consumed (dropping the queued
        // styling instantly on the client), spawns a parallel chat handler
        // that races the original for the session lock, and the inject text
        // gets lost. With the check we push to the queue; drainInjectsIntoTurn
        // at the top of driveTurn picks it up on the first iteration.
        const liveOps = listOpsForSession(sessionId);
        const hasPending = hasChatHandlerPending(sessionId);
        if (liveOps.length === 0 && !hasPending) {
          const handler = getChatHandler();
          if (handler) {
            logger.info(`[ws-chat] inject routed to new turn sess=${sessionId} len=${text.length} (no live ops, no pending handler)`);
            // Mirror the queue-drain path: tell the client this inject is
            // no longer "queued" so the local echo bubble drops its pending
            // styling. The new turn's response will arrive via the normal
            // stream path.
            if (clientInjectId) broadcastToSession(sessionId, { type: "inject_consumed", injectId: clientInjectId });
            handler(sessionId, text, []);
            return;
          }
          logger.warn(`[ws-chat] inject dropped sess=${sessionId} — no live ops and no chat handler`);
          return;
        }
        const injectId = pushInject(sessionId, text, clientInjectId);
        logger.info(`[ws-chat] inject queued sess=${sessionId} len=${text.length} id=${injectId.slice(0, 8)} liveOps=${liveOps.length} pending=${hasPending}`);
        broadcastToSession(sessionId, { type: "inject_queued", injectId });
      } catch (e) {
        logger.warn(`[ws-chat] inject failed: ${(e as Error).message}`);
      }
      return;
    }

    if (type === "chat" && sessionId) {
      await handleChat(ctx, sessionId, msg);
      return;
    }

    if (type === "ide_runtime_error" && sessionId) {
      await handleIdeRuntimeError(sessionId, msg);
      return;
    }

    if (type === "agent-redirect" && msg.agentId && msg.instruction) {
      await handleAgentRedirect(ws, String(msg.agentId), String(msg.instruction));
      return;
    }

    if (type === "approval_response" && msg.approvalId) {
      handleApprovalResponse(ws, msg);
      return;
    }

    if (type === "agent-control" && msg.agentId && msg.action) {
      await handleAgentControl(ws, String(msg.agentId), String(msg.action));
      return;
    }
  });
}

// Reconnect to a canonical op's event stream after a connection drop.
// Client tracks opId from chat_op_started + last canonical seq; on WS
// reconnect this replays missed events and re-attaches to the live tail.
// Stream chunks during the disconnect window are NOT replayed (ephemeral
// by design); finalized message text arrives via canonical
// `message_appended` events whose payload points at op_messages on disk.
async function handleReconnectOp(ws: WebSocket, sessionId: string, opId: string, sinceSeq: number): Promise<void> {
  try {
    const { reconnectOp, OP_EVENTS_FROM_BEGINNING, readOpMessages } =
      await import("../canonical-loop/index.js");
    const result = await reconnectOp(opId, sinceSeq < 0 ? OP_EVENTS_FROM_BEGINNING : sinceSeq, (event) => {
      // Translate canonical events to chat ServerEvents and send ONLY
      // to this WS (not broadcast — other connections didn't ask for
      // this replay). The session-bridge-observer handles ongoing live
      // broadcasts to all session subscribers.
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

    // Send the assistant's finalized text from op_messages. MUST use
    // `replace: true` with `text` (not `delta`) — the client's stream
    // handler does `content += event.delta` for non-replace events, so
    // a delta-shaped replay would CONCATENATE the full text onto
    // already-streamed content and the bubble would visibly duplicate
    // the response. Live failure 2026-05-19: same sentence appearing
    // 2-3× stacked inside one bubble; fixed on chat-leave+return
    // because renderMessages rebuilds from op_messages (single copy).
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
              event: { type: "stream", text, replace: true },
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
}

function handleStop(sessionId: string): void {
  // Stop must mean stop, not "stop and wait." terminateChat aborts the
  // in-flight provider stream + releases the turn lock immediately, so the
  // next user send doesn't hit "previous request still running" while the
  // agent's finally block drains (which can take 60+ seconds if a
  // subprocess stalls).
  terminateChat(sessionId, { abort: true, errorMessage: "Stopped by user" });
}

async function handleChat(ctx: RouterContext, sessionId: string, msg: Record<string, unknown>): Promise<void> {
  // Accept the message if there's text OR at least one attachment.
  // Image-only sends (paste-and-send with no typed caption) have
  // msg.message === "" and would silently drop without this guard.
  const _atts = (msg.attachments || []) as unknown[];
  const _msgText = typeof msg.message === "string" ? msg.message : "";
  const handler = getChatHandler();
  // [chat-diag] grep-able trace for the fresh-install chat-doesnt-work
  // bug. Routes through console.log so it lands in ~/.lax/logs/server.log
  // (logger.* writes direct to process.stdout, bypassing the file
  // override in index.ts).
  console.log(`[chat-diag] ws-chat recv sess=${sessionId.slice(-8)} len=${_msgText.length} atts=${_atts.length} handler=${handler ? "set" : "null"}`);
  if (!_msgText && _atts.length === 0) {
    logger.warn(`[ws-chat] dropping empty chat from sess=${sessionId} (no text and no attachments)`);
    return;
  }
  const _imgCount = _atts.filter(a => (a as { isImage?: unknown })?.isImage).length;
  logger.info(`[ws-chat] recv sess=${sessionId} msg_len=${_msgText.length} atts=${_atts.length} imgs=${_imgCount} handler=${handler ? "set" : "null"}`);
  // Stamp the chat's current project onto the session so agent_* tool
  // calls auto-scope. The frontend includes projectId on each chat
  // message when the chat is nested under a project.
  try {
    const { setSessionProject } = await import("../session/project.js");
    setSessionProject(sessionId, typeof msg.projectId === "string" ? msg.projectId : null);
  } catch (e) {
    logger.warn(`[ws-chat] failed to set session project: ${(e as Error).message}`);
  }
  ctx.subscriptions.add(sessionId);
  if (handler) handler(sessionId, _msgText, _atts);
}

// Route by id prefix:
//   - op_*    → worker-pool op, use canonical opRedirect
//   - agent-* → legacy Handler.redirectAgent
// Pre-fix bug: handler used Handler unconditionally for both id shapes.
// op_* redirects silently no-opped because Handler doesn't track
// worker-pool ids — the user typed a redirect, hit Enter, saw nothing
// happen, and the worker kept doing the wrong thing.
async function handleAgentRedirect(ws: WebSocket, agentId: string, instruction: string): Promise<void> {
  try {
    if (agentId.startsWith("op_")) {
      const { opRedirect } = await import("../canonical-loop/index.js");
      const res = opRedirect(agentId, instruction, "user");
      if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not running (cannot redirect)` }));
    } else {
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      handler.redirectAgent(agentId, instruction);
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `Redirect failed: ${(e as Error).message}` }));
  }
}

function handleApprovalResponse(ws: WebSocket, msg: Record<string, unknown>): void {
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

// Route by id prefix. Three id shapes coexist in the AGENTS sidebar:
//   - op_ap_*  → autopilot ops (separate lifecycle, only stop is supported)
//   - op_*     → canonical-loop ops (opCancel / opPause / opResume)
//   - agent-*  → legacy Handler sub-agents
async function handleAgentControl(ws: WebSocket, agentId: string, action: string): Promise<void> {
  try {
    if (agentId.startsWith("op_ap_")) {
      const { requestStop } = await import("../autopilot/loop.js");
      try {
        const result = requestStop(agentId);
        if (!result) {
          ws.send(JSON.stringify({ type: "error", message: `Autopilot ${agentId} not active (already finished or unknown)` }));
        } else if (action === "pause" || action === "resume") {
          ws.send(JSON.stringify({ type: "error", message: `Autopilot doesn't support pause/resume — sent stop instead. Run will end after current round.` }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: `Autopilot stop failed: ${(e as Error).message}` }));
      }
    } else if (agentId.startsWith("op_")) {
      const { opCancel, opPause, opResume } = await import("../canonical-loop/index.js");
      switch (action) {
        case "cancel": {
          const res = opCancel(agentId, "user-stop");
          if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not found (already finished)` }));
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
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      switch (action) {
        case "pause":  handler.pauseAgent(agentId); break;
        case "resume": handler.resumeAgent(agentId); break;
        case "cancel": handler.cancelAgent(agentId); break;
        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${action}` }));
      }
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `Agent control failed: ${e}` }));
  }
}
