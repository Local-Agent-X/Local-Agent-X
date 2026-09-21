// The reconnect_op frame: replay an op's missed canonical events to ONE
// socket and re-attach it to the live tail.
//
// Split from ./message-router.ts (2026-09-21, 400-LOC gate). The router keeps
// the frame dispatch; everything reconnect_op needs — the per-socket
// subscription bookkeeping and the committed-text join it replays — lives
// here, because those two exist for this handler alone.

import type { WebSocket } from "ws";
import { createLogger } from "../logger.js";

const logger = createLogger("chat-ws");

// Reconnect to a canonical op's event stream after a connection drop.
// Client tracks opId from chat_op_started + last canonical seq; on WS
// reconnect this replays missed events and re-attaches to the live tail.
// Stream chunks during the disconnect window are NOT replayed (ephemeral
// by design); finalized message text arrives via canonical
// `message_appended` events whose payload points at op_messages on disk.
// One live op subscription per socket per op.
//
// reconnect_op is not a once-per-connection call: the client's stuck-stream
// watchdog re-sends it every 15s for as long as a turn looks stalled
// (chat-ws.js). Each call installs a subscription, and detaching only on
// socket close meant a turn that stalled for a few minutes ended up delivering
// its single error/done once per elapsed tick — the "4 identical error bubbles
// from one server event" trace. Replacing the previous subscription for the
// same op keeps the socket at exactly one.
const liveOpSubscriptions = new WeakMap<WebSocket, Map<string, () => void>>();

function claimOpSubscription(ws: WebSocket, opId: string): (off: () => void) => void {
  let bySocket = liveOpSubscriptions.get(ws);
  if (!bySocket) {
    bySocket = new Map();
    liveOpSubscriptions.set(ws, bySocket);
    const all = bySocket;
    ws.on("close", () => {
      for (const off of all.values()) off();
      all.clear();
    });
  }
  const held = bySocket;
  held.get(opId)?.();
  held.delete(opId);
  return (off) => held.set(opId, off);
}

export async function handleReconnectOp(ws: WebSocket, sessionId: string, opId: string, sinceSeq: number): Promise<void> {
  const holdSubscription = claimOpSubscription(ws, opId);
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
    // Held until this op's next reconnect_op replaces it, or the socket closes.
    if (result.ok) holdSubscription(result.off);
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
