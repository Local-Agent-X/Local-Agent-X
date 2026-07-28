import type { ProcessRelayBrowserDelivery } from "../canonical-loop/public/process-relay.js";
import { clients } from "./state.js";

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

export function sendProcessRelayDelivery(delivery: ProcessRelayBrowserDelivery): number {
  const payload = JSON.stringify(delivery);
  const globalIndexes = delivery.events
    .map((event, index) => GLOBAL_EVENT_TYPES.has(event.type) ? index : -1)
    .filter(index => index >= 0);
  const globalPayload = delivery.scope === "mixed" ? JSON.stringify({
    ...delivery,
    scope: "global",
    ackRequired: false,
    events: globalIndexes.map(index => delivery.events[index]),
    eventIds: globalIndexes.map(index => delivery.eventIds[index]),
  }) : payload;
  let sent = 0;
  for (const [ws, subscriptions] of clients) {
    if (ws.readyState !== 1) continue;
    if (delivery.scope === "session" && !subscriptions.has(delivery.sessionId)) continue;
    if (delivery.scope === "mixed" && !subscriptions.has(delivery.sessionId)) ws.send(globalPayload);
    else ws.send(payload);
    sent++;
  }
  return sent;
}
