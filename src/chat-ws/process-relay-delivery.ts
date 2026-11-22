import type { ProcessRelayBrowserDelivery } from "../canonical-loop/public/process-relay.js";
import { clients } from "./state.js";
import { isHeadlessSession } from "./broadcast.js";
import { serializeFrame } from "./frames.js";

// The ONE set that decides relay audience: ServerEvent discriminators every
// connected client sees, not just the op's session. Both halves of the relay
// read it from here — this module splits a "mixed" delivery on it, and
// process-relay-browser.ts classifies each delivery's scope on it. It lives on
// this side because that module already imports sendProcessRelayDelivery from
// here, so owning it there would close an import cycle.
//
// Not to be confused with SESSION_EVENT_TYPES (process-relay-contract.ts):
// that set is "carriable over the relay at all" and every ServerEvent must be
// in it; this one is "who gets to see it".
export const GLOBAL_EVENT_TYPES = new Set([
  "bg_op_queued", "bg_op_started", "bg_op_progress", "bg_op_completed", "bg_op_nudge",
]);

/**
 * Send one worker's batch to the tabs that should see it. The audience differs
 * from broadcastToSession's (a batch can be global, session-only or both), so
 * the loop is this module's; everything else is shared: serializeFrame masks
 * the events' credentials, and a headless session's events reach no tab
 * (isHeadlessSession), as on the in-process path.
 */
export function sendProcessRelayDelivery(delivery: ProcessRelayBrowserDelivery): number {
  const payload = serializeFrame(delivery);
  const globalIndexes = delivery.events
    .map((event, index) => GLOBAL_EVENT_TYPES.has(event.type) ? index : -1)
    .filter(index => index >= 0);
  const globalPayload = delivery.scope === "mixed" ? serializeFrame({
    ...delivery,
    scope: "global",
    ackRequired: false,
    events: globalIndexes.map(index => delivery.events[index]),
    eventIds: globalIndexes.map(index => delivery.eventIds[index]),
  }) : payload;
  const sessionHasTabs = !isHeadlessSession(delivery.sessionId);
  let sent = 0;
  for (const [ws, subscriptions] of clients) {
    if (ws.readyState !== 1) continue;
    const subscribed = sessionHasTabs && subscriptions.has(delivery.sessionId);
    if (delivery.scope === "session" && !subscribed) continue;
    ws.send(delivery.scope === "mixed" && !subscribed ? globalPayload : payload);
    sent++;
  }
  return sent;
}
