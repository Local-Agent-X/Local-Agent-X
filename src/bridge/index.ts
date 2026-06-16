// Mobile bridge — opt-in tailnet exposure of the existing LAX server.
//
// When LAX_BRIDGE_ENABLED is set, the SAME http.Server that listens on
// 127.0.0.1 also binds to the Tailscale tailnet interface, so a paired phone
// on the tailnet can reach the existing /ws/chat, /ws/voice, and /api/apps.
// We do NOT create a second server or a parallel transport — the existing
// upgrade handlers and request handler serve both binds. Auth on the tailnet
// side is enforced by the shared authorizeUpgrade gate (per-device tokens).
//
// When the flag is OFF this module does nothing and the server stays
// loopback-only — exactly today's behavior.

import type { Server } from "node:http";
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
}

/**
 * If the bridge is enabled, add a tailnet bind to the existing server. The
 * server is already (or about to be) listening on 127.0.0.1; this adds a second
 * listen on the tailnet address for the SAME server instance.
 *
 * Returns a result describing what happened (bound + addr, or skipped + reason)
 * so the caller can log it on the startup banner. Never throws — a bridge that
 * can't bind must not take the loopback server down.
 */
export function maybeBindBridge(server: Server, port: number): Promise<BridgeBindResult> {
  const cfg = loadBridgeConfig();
  if (!cfg.enabled) return Promise.resolve({ bound: false, reason: "disabled (LAX_BRIDGE_ENABLED not set)" });

  const addr = resolveBridgeBindAddr(cfg.bindAddrOverride);
  if (!addr) {
    logger.warn(
      "[bridge] enabled but no Tailscale (100.64.0.0/10) interface found and no LAX_BRIDGE_BIND_ADDR set — " +
      "staying loopback-only. Bring Tailscale up or set LAX_BRIDGE_BIND_ADDR.",
    );
    return Promise.resolve({ bound: false, reason: "no tailnet address" });
  }

  return new Promise<BridgeBindResult>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      logger.warn(`[bridge] tailnet bind ${addr}:${port} failed (${err.code ?? err.message}) — staying loopback-only`);
      server.off("error", onError);
      resolve({ bound: false, reason: `bind failed: ${err.code ?? err.message}` });
    };
    server.on("error", onError);
    server.listen(port, addr, () => {
      server.off("error", onError);
      logger.info(`[bridge] tailnet bind active at http://${addr}:${port} (paired devices only)`);
      resolve({ bound: true, addr });
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

export { loadBridgeConfig, isBridgeEnabled } from "./config.js";
export { detectTailnetAddr, resolveBridgeBindAddr } from "./tailnet.js";
export { getDeviceRegistry } from "./device-registry.js";
export { issueChallenge, claim } from "./pairing.js";
export { authorizeUpgrade } from "./upgrade-auth.js";
