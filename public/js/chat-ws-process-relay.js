// Durable child-process output reaches the ordinary chat reducers through one
// stable envelope. Remember only completed deliveries: a render failure leaves
// the server record pending and eligible for replay.
var PROCESS_RELAY_SEEN_KEY = 'lax-process-relay-events-seen-v1';
var processRelaySeen = loadProcessRelaySeen();

function handleProcessRelayDelivery(msg, dispatch) {
  if (!msg || msg.type !== 'process_relay_delivery') return false;
  if (typeof msg.deliveryId !== 'string' || typeof msg.opId !== 'string'
      || typeof msg.sessionId !== 'string' || typeof msg.generationId !== 'string'
      || !Number.isSafeInteger(msg.cursor) || !Array.isArray(msg.events)
      || !Array.isArray(msg.eventIds) || msg.eventIds.length !== msg.events.length
      || msg.eventIds.some(function(id) { return typeof id !== 'string'; })) return true;
  for (var i = 0; i < msg.events.length; i++) {
    if (processRelaySeen.has(msg.eventIds[i])) continue;
    try {
      if (dispatch({ type: 'event', sessionId: msg.sessionId, event: msg.events[i] }) !== true) {
        console.warn('[process-relay] render did not confirm success; delivery remains pending');
        return true;
      }
    } catch (e) {
      console.warn('[process-relay] render failed; delivery remains pending', e);
      return true;
    }
    rememberProcessRelayEvent(msg.eventIds[i]);
  }
  if (msg.ackRequired !== false) sendProcessRelayAck(msg);
  return true;
}

function sendProcessRelayAck(msg) {
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
  chatWs.send(JSON.stringify({
    type: 'process_relay_ack',
    opId: msg.opId,
    sessionId: msg.sessionId,
    generationId: msg.generationId,
    cursor: msg.cursor,
    deliveryId: msg.deliveryId,
  }));
}

function loadProcessRelaySeen() {
  try {
    var parsed = JSON.parse(localStorage.getItem(PROCESS_RELAY_SEEN_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(function(x) { return typeof x === 'string'; }) : []);
  } catch (_) { return new Set(); }
}

function rememberProcessRelayEvent(eventId) {
  processRelaySeen.add(eventId);
  while (processRelaySeen.size > 512) processRelaySeen.delete(processRelaySeen.values().next().value);
  try { localStorage.setItem(PROCESS_RELAY_SEEN_KEY, JSON.stringify(Array.from(processRelaySeen))); } catch (_) {}
}
