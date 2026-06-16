// Mobile bridge — opt-in tailnet exposure of the existing LAX server.
//
// When the bridge is enabled, a paired phone on the Tailscale tailnet can reach
// the existing /ws/chat, /ws/voice, and /api/apps. Auth on the tailnet side is
// enforced by the shared authorizeUpgrade gate (per-device tokens) — the same
// gate the loopback server uses.
//
// THE BIND. A single http.Server CANNOT .listen() twice — Node throws
// ERR_SERVER_ALREADY_LISTEN synchronously from the second .listen() call. So we
// bind the tailnet address with a SECOND http.Server that SHARES:
//   • the same request listener (createServer(requestHandler)), and
//   • the same `upgrade` listeners as the loopback server (chat-ws, voice-ws,
//     the upgrade reaper) — copied over verbatim.
// Those upgrade handlers are bound to their own `noServer` WebSocketServer
// instances, so they're server-agnostic and route by path identically over both
// binds. Every connection still passes authorizeUpgrade, so tailnet traffic is
// gated exactly like loopback.
//
// We bind ONLY to the resolved tailnet (100.64.0.0/10) address (or an explicit
// LAX_BRIDGE_BIND_ADDR for a deliberate relay) — NEVER 0.0.0.0/public
// (constitution §6). When the flag is OFF this module does nothing and the
// server stays loopback-only — exactly today's behavior.

import { createServer, type Server, type RequestListener } from "node:http";
import { loadBridgeConfig } from "./config.js";
import { resolveBridgeBindAddr } from "./tailnet.js";
import { getDeviceRegistry } from "./device-registry.js";
import { closeDeviceSockets } from "./upgrade-auth.js";
import { createLogger } from "../logger.js";

const logger = createLogger("bridge");

export interface BridgeBindResult {
  bound: boolean;
  addr?: string;
  reason?: string;
  /** The second server bound to the tailnet, when bound. Caller owns its close. */
  tailnetServer?: Server;
}

/**
 * Build (but do NOT listen on) the tailnet-side http.Server. It shares the SAME
 * request listener as the loopback server and the SAME `upgrade` listeners
 * (copied off the loopback server), so /ws/chat, /ws/voice and /api/apps behave
 * identically over both binds. Pure + synchronous so the wiring is unit-testable
 * without binding a real socket.
 */
export function createTailnetServer(loopbackServer: Server, requestHandler: RequestListener): Server {
  const tailnetServer = createServer(requestHandler);
  // Re-attach the loopback server's upgrade handlers. They're closures over
  // `noServer` WebSocketServers and the upgrade reaper — server-instance
  // agnostic — so the tailnet bind gets the exact same WS routing + auth.
  for (const listener of loopbackServer.listeners("upgrade")) {
    tailnetServer.on("upgrade", listener as (...args: unknown[]) => void);
  }
  return tailnetServer;
}

/**
 * If the bridge is enabled, bind the tailnet address with a second http.Server
 * that shares the loopback server's request + upgrade handlers.
 *
 * Returns a result describing what happened (bound + addr, or skipped + reason)
 * so the caller can log it on the startup banner. Never throws — a bridge that
 * can't bind must not take the loopback server down.
 */
export function maybeBindBridge(
  loopbackServer: Server,
  requestHandler: RequestListener,
  port: number,
): Promise<BridgeBindResult> {
  const cfg = loadBridgeConfig();
  if (!cfg.enabled) return Promise.resolve({ bound: false, reason: "disabled" });

  const addr = resolveBridgeBindAddr(cfg.bindAddrOverride);
  if (!addr) {
    logger.warn(
      "[bridge] enabled but no Tailscale (100.64.0.0/10) interface found and no LAX_BRIDGE_BIND_ADDR set — " +
      "staying loopback-only. Bring Tailscale up or set LAX_BRIDGE_BIND_ADDR.",
    );
    return Promise.resolve({ bound: false, reason: "no tailnet address" });
  }

  const tailnetServer = createTailnetServer(loopbackServer, requestHandler);

  return new Promise<BridgeBindResult>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      logger.warn(`[bridge] tailnet bind ${addr}:${port} failed (${err.code ?? err.message}) — staying loopback-only`);
      tailnetServer.off("error", onError);
      try { tailnetServer.close(); } catch { /* never listened */ }
      resolve({ bound: false, reason: `bind failed: ${err.code ?? err.message}` });
    };
    tailnetServer.on("error", onError);
    tailnetServer.listen(port, addr, () => {
      tailnetServer.off("error", onError);
      logger.info(`[bridge] tailnet bind active at http://${addr}:${port} (paired devices only)`);
      resolve({ bound: true, addr, tailnetServer });
    });
  });
}

/**
 * Revoke a paired device: flip its registry status AND force-close any live
 * sockets it currently holds (constitution §5/§7 — instant, no hang).
 * Returns whether the device existed + was active.
 */
export function revokeDevice(deviceId: string): { revoked: boolean; closedSockets: number } {
  const revoked = getDeviceRegistry().revoke(deviceId);
  const closedSockets = revoked ? closeDeviceSockets(deviceId) : 0;
  return { revoked, closedSockets };
}

export { loadBridgeConfig, isBridgeEnabled, loadPersistedBridgeEnabled, BRIDGE_ENABLED_SETTING } from "./config.js";
export { detectTailnetAddr, resolveBridgeBindAddr } from "./tailnet.js";
export { getDeviceRegistry } from "./device-registry.js";
export { issueChallenge, claim } from "./pairing.js";
export { authorizeUpgrade } from "./upgrade-auth.js";
