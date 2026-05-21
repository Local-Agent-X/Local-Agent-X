// Per-connection lifecycle for a freshly-accepted chat WS client.
// Sets up:
//   - 24h max-age timer (forces re-auth)
//   - heartbeat (native ws ping/pong + JSON ping/pong)
//   - initial state replay (active chats list + active autopilot ops)
// The message router itself is registered separately by the caller.

import type { WebSocket } from "ws";
import { activeChats, clients } from "./state.js";

const WS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25_000;

export interface ConnectionContext {
  subscriptions: Set<string>;
}

export function setupConnection(ws: WebSocket): ConnectionContext {
  const subscriptions = new Set<string>();
  clients.set(ws, subscriptions);

  // Auto-close after 24h to force re-authentication.
  const maxAgeTimer = setTimeout(() => {
    ws.close(4002, "Session expired — please reconnect");
  }, WS_MAX_AGE_MS);
  ws.on("close", () => clearTimeout(maxAgeTimer));

  // Heartbeat — detect half-open TCP/WebSocket connections that the
  // protocol alone won't surface. Without this, client's ws.readyState
  // stays OPEN long after the server-side socket is dead (TCP RST not
  // delivered, OS-level half-close) — every chat-send lands in a
  // buffer that goes nowhere. Restarting "fixes" it because the client
  // finally sees onclose.
  //
  // Two-channel design:
  //   1. Native WS ping/pong (handled by ws library) — server pings
  //      every 25s; no pong by next tick = terminate, forcing onclose
  //      on the client which triggers its reconnect loop.
  //   2. JSON {type:"ping"} from the client (browser API doesn't
  //      expose protocol-level pings) — handled in the message router.
  let isAlive = true;
  ws.on("pong", () => { isAlive = true; });
  const heartbeatTimer = setInterval(() => {
    if (!isAlive) {
      try { ws.terminate(); } catch { /* already dead */ }
      return;
    }
    isAlive = false;
    try { ws.ping(); } catch { /* socket dying */ }
  }, HEARTBEAT_INTERVAL_MS);
  ws.on("close", () => clearInterval(heartbeatTimer));

  // Send the list of currently active chats so the client can populate
  // its "live indicator" badges immediately on connect.
  ws.send(JSON.stringify({
    type: "active_chats",
    sessionIds: [...activeChats.keys()].filter(id => !activeChats.get(id)!.done),
  }));

  // Replay bg_op_started for currently-running autopilot ops so a
  // fresh page load (or post-restart reconnect) sees the AGENTS card
  // for runs that started before this WS connection. Without this, an
  // autopilot launched at T0, server restarted at T1, browser
  // reconnected at T2 = no visibility until the next bg_op_progress
  // (5+ minutes away).
  void (async () => {
    try {
      const { listActiveAutopilotOps } = await import("../autopilot/loop.js");
      for (const op of listActiveAutopilotOps()) {
        ws.send(JSON.stringify({
          type: "event",
          sessionId: "autopilot",  // chat.js requires truthy sessionId
          event: {
            type: "bg_op_started",
            opId: op.id,
            task: op.autopilot?.topic || "Autopilot",
            provider: "autopilot",
          },
        }));
      }
    } catch { /* autopilot module not loadable — skip silently */ }
  })();

  ws.on("close", () => {
    clients.delete(ws);
  });

  return { subscriptions };
}
