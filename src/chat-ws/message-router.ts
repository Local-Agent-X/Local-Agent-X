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
  broadcastToSession,
  getChatHandler,
  getMessageCountForSession,
  terminateChat,
} from "./state.js";
import { replayBufferedEvents } from "./replay.js";
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
import { setEnforcedPlanMode, isEnforcedPlanMode } from "../canonical-loop/public/plan-ledger.js";
import { clearSoftPlanMode } from "../tools/plan-tools.js";
import { handleAgentRedirect, handleAgentControl } from "./agent-controls.js";
import { resolveDurableApproval } from "./approval-durable-resolve.js";
import type { ScreenAttachment } from "../screen-stream/index.js";

const logger = createLogger("chat-ws");

export interface RouterContext {
  ws: WebSocket;
  subscriptions: Set<string>;
  /** Live-screen signaling session for device sockets (null for operator). */
  screen?: ScreenAttachment | null;
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
    // CT-7: JSON.parse accepts non-object literals (`null`, `42`, `"x"`) and
    // arrays. A bare `null` frame parses fine, then `msg.type` throws
    // TypeError → unhandledRejection (survived only by the global crash
    // guard, one CRASH line per frame). Require a plain object to dispatch.
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;

    // WebRTC live-screen signaling (rtc_*) — consumed by the per-device session
    // before the chat branches; returns true when it claimed the frame.
    if (ctx.screen && ctx.screen.handleMessage(msg)) return;

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
      // CT-3: coalesce buffered stream deltas into one `replace` on replay so
      // a mid-turn reconnect doesn't append the whole partial onto the partial
      // the client already holds (duplicated bubble + corrupted persisted
      // history once promoteLiveToMessages runs).
      replayBufferedEvents(ws, sessionId);
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
          planMode: isEnforcedPlanMode(sessionId),
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

    // Enforced plan mode toggle — a user-only control. enabled:false IS the
    // approval event: it lifts the standing mutation ban (and any model-set
    // soft plan mode) in one step. Pre-dispatch reads the flag dynamically,
    // so a mid-op approval unblocks the very next tool call.
    if (type === "plan_mode" && sessionId && typeof msg.enabled === "boolean") {
      const changed = setEnforcedPlanMode(sessionId, msg.enabled);
      if (!msg.enabled) clearSoftPlanMode(sessionId);
      if (changed) logger.info(`[ws-chat] enforced plan mode ${msg.enabled ? "ON" : "OFF (user approval)"} sess=${sessionId}`);
      broadcastToSession(sessionId, { type: "plan_mode_changed", enforced: msg.enabled });
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
        // A mid-turn user message while approval cards are pending = the user
        // answered in words, not clicks. Deny the cards FIRST (no suppression;
        // model may re-raise after reading) — this also unblocks a tool call
        // parked on the card, so the inject below actually gets drained
        // instead of sitting behind an indefinite approval wait.
        const denied = getApprovalManager().denyPendingForSession(sessionId);
        if (denied > 0) logger.info(`[ws-chat] user message denied ${denied} pending approval(s) sess=${sessionId}`);
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
      await handleApprovalResponse(ws, msg);
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
    //
    // AND it must be exactly ONE replace for the whole op. A multi-
    // iteration turn (text → tool → more text) commits N assistant
    // messages, but the client keeps a single live bubble whose replace
    // handler sets `content = text` wholesale — so N per-message replaces
    // left only the LAST message's text in the bubble, and the client
    // then persisted that truncated content on `done`. Join all assistant
    // texts with "\n\n", mirroring the paragraph break the live path
    // inserts after tool calls (chat-stream-store.js toolsSinceText).
    if (result.ok) {
      try {
        const messages = readOpMessages(opId);
        const text = joinAssistantText(messages);
        if (text) {
          ws.send(JSON.stringify({
            type: "event",
            sessionId,
            event: { type: "stream", text, replace: true },
            _opId: opId,
            _replay: true,
          }));
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

// Pure join for reconnect replay: all committed assistant texts of an op,
// in commit order, separated by a blank line ("\n\n" — the same paragraph
// break the client's live path inserts after tool calls). Non-assistant
// messages and empty/non-string texts are skipped; zero assistant text
// yields "" and the caller sends nothing.
//
// Seeds are not commits: create-op seeds the ENTIRE prior session history
// into the op file for provider context (seed-messages.ts stamps those
// rows "hist-"; the current turn's user message is "um-"). Filtering on
// role alone would replay every past assistant reply into the live bubble
// — and the client would persist that contamination on done — so "hist-"
// rows are excluded here. Exported for tests.
export function joinAssistantText(messages: Array<{ role?: unknown; content?: unknown; messageId?: unknown }>): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.messageId === "string" && m.messageId.startsWith("hist-")) continue;
    const content = m.content as { text?: unknown } | null | undefined;
    const text = typeof content?.text === "string" ? content.text : "";
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
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
  // Stamp the IDE app's dir as the session work root, the same way and for the
  // same reason as projectId above: the App IDE frame carries appId, and
  // without it every tool default (relative paths, bash cwd, glob's search
  // base) anchored to the project root — an IDE turn for one app globbed the
  // whole repo and edited the platform's own CSS (2026-07-15). Cleared for
  // frames with no appId, so a non-IDE chat never inherits an anchor.
  try {
    const { stampIdeWorkRoot } = await import("../session/ide-work-root.js");
    const anchored = stampIdeWorkRoot(sessionId, msg.appId);
    if (anchored) logger.info(`[ws-chat] sess=${sessionId} anchored to ${anchored}`);
  } catch (e) {
    logger.warn(`[ws-chat] failed to set IDE work root: ${(e as Error).message}`);
  }
  ctx.subscriptions.add(sessionId);
  if (handler) handler(sessionId, _msgText, _atts);
}

async function handleApprovalResponse(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
  const approvalId = String(msg.approvalId);
  const approved = Boolean(msg.approved);
  const rememberForSession = Boolean(msg.rememberForSession);
  try {
    // Happy path: the card is live in-process — the waiting tool call's
    // promise settles and the manager's settle hook does the durable
    // bookkeeping. No reply needed (unchanged behavior).
    if (getApprovalManager().resolveApproval(approvalId, approved, rememberForSession)) return;
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `Approval response failed: ${e}` }));
    return;
  }
  // Unknown in-process (restart / rediscovered durable card) — fall through
  // to the durable-record resolve. `opId` is optional on the frame; durable
  // cards from /api/approvals/pending carry it.
  await resolveDurableApproval(ws, approvalId, approved, rememberForSession, msg.opId);
}

