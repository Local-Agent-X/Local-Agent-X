// Branches on msg.type from the WS client. Each handler is small enough
// to keep inline; splitting per-handler would scatter the routing
// without making any single branch easier to follow.
//
// ONE exception, taken deliberately: `inject` lives in ./inject-router.ts.
// It outgrew "small enough" — a three-signal liveness decision plus a
// deferred promote-on-release pass that outlives the frame that armed it —
// and its own explanation was the longest thing in this file.
//
// Subscribe / unsubscribe mutate the per-connection subscription set;
// stop / reconnect_op / etc. operate on session-level state.

import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";
import { getApprovalManager } from "../approval-manager.js";
import { getChatHandler } from "./chat-handler.js";
import { getMessageCountForSession } from "./state.js";
import { broadcastToSession, terminateChat } from "./broadcast.js";
import { replayBufferedEvents } from "./replay.js";
import { handleReconnectOp } from "./reconnect-op.js";
import { handleIdeRuntimeError } from "./ide-runtime-error.js";
// Static import, like everything the inject path touches: that path is
// synchronous by contract (see inject-router.ts's import note).
import { handleInject } from "./inject-router.js";
import { hasActiveTurn } from "../session/turn-lock.js";
import { setEnforcedPlanMode, isEnforcedPlanMode } from "../canonical-loop/public/plan-ledger.js";
import { clearSoftPlanMode } from "../tools/plan-tools.js";
import { handleAgentRedirect, handleAgentControl } from "./agent-controls.js";
import { resolveDurableApproval } from "./approval-durable-resolve.js";
import type { ScreenAttachment } from "../screen-stream/index.js";
import { handleProcessRelayAck } from "./process-relay-router.js";
import { reconcileAllPendingProcessRelays } from "../canonical-loop/public/process-relay.js";

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

    if (handleProcessRelayAck(msg, subscriptions)) return;

    if (type === "subscribe" && sessionId) {
      subscriptions.add(sessionId);
      setImmediate(() => reconcileAllPendingProcessRelays(sessionId));
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
      handleInject(
        sessionId,
        msg.message.trim(),
        typeof msg.injectId === "string" && msg.injectId ? msg.injectId : undefined,
      );
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
  // A `chat` re-send that arrives WHILE a turn holds this session must be
  // ABSORBED into that turn, not routed to startChat. The turn lock's
  // tryAcquireOrReplace would otherwise either abort+replace the live turn or
  // refuse with "previous request still running, cancel it first" — so a user
  // who re-sends because the app looks hung gets a duplicated bubble or a
  // restarted answer. The inject lane already does the right thing: queue it
  // and let the running turn drain it inline (or, once nothing is live, promote
  // it). Route through that SAME machinery rather than forking a parallel
  // absorb path. Text-only: injects carry no attachments, so a re-send that
  // includes an image still takes the normal path rather than silently
  // dropping the attachment. Synchronous, ahead of the awaits below, for the
  // same reason inject-router.ts is (its enqueue must not yield mid-frame).
  if (_msgText && _atts.length === 0 && hasActiveTurn(sessionId)) {
    ctx.subscriptions.add(sessionId); // so this socket receives the inject_* acks
    handleInject(sessionId, _msgText, typeof msg.injectId === "string" && msg.injectId ? msg.injectId : undefined);
    return;
  }
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
  // base) anchored to the workspace — an IDE turn for one app globbed the
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
  // The broker chat-bridge stamps phone frames with origin:"mobile" so the
  // turn knows the user is on the AgentX app, not the desktop UI. Validated —
  // arbitrary origin claims from other clients are dropped, not trusted.
  const { parseFrameOrigin } = await import("../channel-context.js");
  const origin = parseFrameOrigin(msg.origin);
  if (handler) handler(sessionId, _msgText, _atts, origin ? { channel: origin } : undefined);
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

