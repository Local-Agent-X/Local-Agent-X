// Wire the ops-side broadcasters (session-bridge + idle-nudge) at chat
// WS setup time. Done here (not in the setup callers) so the bridge
// wiring lives in one place tied to chat WS lifetime.
//
// Routing rule: bg_op_* events go to ALL connected clients because the
// AGENTS sidebar is a global surface (showing every background op
// regardless of which session triggered it — web chat, Telegram,
// WhatsApp, voice, autopilot, cron). Per-session routing made
// bridge-originated ops invisible since their sessionIds (`tg-XXX`,
// `wa-XXX`) are never subscribed by the local UI. Everything else
// stays per-session.

import { setSessionBroadcaster } from "../ops/session-bridge.js";
import { setIdleNudgeBroadcaster } from "../ops/idle-nudge.js";
import { activeChats, broadcastAll, broadcastToSession } from "./state.js";
import type { ActiveChat } from "./state.js";
import type { ServerEvent } from "../types.js";

// Buffer a replay event with the SAME 500→400 cap manager.onEvent enforces.
// Bridge-originated streams (bg_op progress, idle-nudge) can run for many
// minutes at a fast throttle; without the trim they grow the replay buffer
// unboundedly and every trim is re-sent to each late subscriber. Keep this in
// lockstep with manager.onEvent's cap.
function pushCappedEvent(chat: ActiveChat, event: ServerEvent): void {
  chat.events.push(event);
  if (chat.events.length > 500) {
    chat.events = chat.events.slice(-400);
  }
}

export function wireBridgeBroadcasters(): void {
  setSessionBroadcaster((sessionId, event) => {
    const chat = activeChats.get(sessionId);
    if (chat) pushCappedEvent(chat, event);
    const isBgOpEvent =
      event.type === "bg_op_queued" ||
      event.type === "bg_op_started" ||
      event.type === "bg_op_progress" ||
      event.type === "bg_op_completed" ||
      event.type === "bg_op_nudge";
    if (isBgOpEvent) {
      broadcastAll({ type: "event", sessionId, event });
    } else {
      broadcastToSession(sessionId, event);
    }
  });

  setIdleNudgeBroadcaster((sessionId, event) => {
    const chat = activeChats.get(sessionId);
    if (chat) pushCappedEvent(chat, event);
    broadcastToSession(sessionId, event);
  });
}
