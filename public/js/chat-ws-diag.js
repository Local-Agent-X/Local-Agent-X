// What this page received on its chat socket, per chat, and when the socket
// dropped. On the next connect the page sends it to the server as a
// `client_diag` frame, which lands in the server log beside the server's own
// record of the same socket (src/chat-ws/connection-log.ts): what the server
// sent and what this page got, side by side.
//
// Why: a turn LAX started by itself (Label Check Sol, 2026-11-27) showed on
// the phone and not on the desktop open on that chat. The desktop window's
// console is written nowhere, so nothing said whether its socket had dropped
// or the frames never came.
(function () {
  const lastBySession = new Map(); // sessionId -> { type, at }
  let drop = null; // { at, reason } of the last time the socket went away
  let connectedAt = 0;

  function noteFrame(msg) {
    if (!msg || !msg.sessionId) return;
    const type = (msg.type === 'event' && msg.event && msg.event.type) || msg.type;
    lastBySession.set(msg.sessionId, { type, at: Date.now() });
  }

  function noteDrop(reason) {
    if (drop) return; // the first cause is the one that matters
    drop = { at: Date.now(), reason: String(reason || 'closed').slice(0, 120) };
  }

  function report(ws) {
    const now = Date.now();
    const last = [...lastBySession.entries()]
      .sort((a, b) => b[1].at - a[1].at).slice(0, 5)
      .map(([sessionId, s]) => ({ sessionId, type: s.type, agoMs: now - s.at }));
    const frame = {
      type: 'client_diag',
      reconnect: !!drop,
      dropReason: drop ? drop.reason : undefined,
      downMs: drop ? now - drop.at : undefined,
      lastConnectedMs: connectedAt ? (drop ? drop.at : now) - connectedAt : undefined,
      lastReceived: last,
    };
    drop = null;
    connectedAt = now;
    try { ws.send(JSON.stringify(frame)); } catch { /* the next connect reports again */ }
  }

  window.laxWsDiag = { noteFrame, noteDrop, report };
})();
