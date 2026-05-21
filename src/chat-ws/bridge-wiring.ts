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

export function wireBridgeBroadcasters(): void {
  setSessionBroadcaster((sessionId, event) => {
    const chat = activeChats.get(sessionId);
    if (chat) chat.events.push(event);
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
    if (chat) chat.events.push(event);
    broadcastToSession(sessionId, event);
  });
}
