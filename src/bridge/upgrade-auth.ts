// Shared WebSocket-upgrade authorization for the bridge.
//
// This is the ONE place that decides whether an incoming /ws/chat or /ws/voice
// upgrade is allowed. It is an EXTENSION of the existing token check, not a
// parallel auth system: it still accepts the operator token (today's loopback
// behavior is byte-for-byte unchanged), and ADDITIONALLY accepts a valid
// per-device bridge token when the bridge is enabled.
//
// When the bridge is OFF no device tokens are ever issued, so authorizeUpgrade
// reduces to "operator token only" — identical to the pre-change code.
//
// It also tracks live device connections so a revoked device can have its open
// sockets force-closed immediately (constitution §7: reject revoked devices,
// never hang).

import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { getDeviceRegistry } from "./device-registry.js";
import { isBridgeEnabled } from "./config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("bridge.upgrade-auth");

/** WS close code for an unauthorized/rejected upgrade (matches constitution §7). */
export const WS_UNAUTHORIZED = 4401;

export interface UpgradeAuthResult {
  ok: boolean;
  /** Principal kind for an accepted connection. */
  principal?: "operator" | "device";
  /** Device id when principal === "device" — used to bind the live socket. */
  deviceId?: string;
  /** Actionable reason on rejection (sent as the WS close message). */
  reason?: string;
}

function constTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authorize a WS upgrade. Accepts the operator token OR (when the bridge is on)
 * an active device token. Returns an actionable reason on rejection so the
 * caller can close with a clear message instead of a silent hang.
 */
export function authorizeUpgrade(token: string, operatorToken: string): UpgradeAuthResult {
  if (token && operatorToken && constTimeEq(token, operatorToken)) {
    return { ok: true, principal: "operator" };
  }
  // Device tokens only exist / are honored when the bridge is enabled.
  if (isBridgeEnabled()) {
    const device = getDeviceRegistry().authenticate(token);
    if (device) return { ok: true, principal: "device", deviceId: device.id };
    // Distinguish "no token" from "bad/revoked token" for the close message.
    if (!token) return { ok: false, reason: "Missing bridge token — pair this device first" };
    return { ok: false, reason: "Unknown, expired, or revoked device — re-pair from the desktop" };
  }
  return { ok: false, reason: "Unauthorized" };
}

/** Endpoints a paired device may reach over HTTP. The mobile app talks to the
 *  agent over WS; over REST it reads the app viewer/state and its OWN
 *  conversations (the phone shows the same chat history + list as the desktop —
 *  load history then subscribe for the live tail, like the web client). Keep
 *  this narrow — a device token is NOT an operator token. */
const DEVICE_HTTP_PREFIXES = ["/api/apps", "/apps/", "/api/sessions", "/api/providers", "/uploads/"];

export function isDeviceAllowedPath(pathname: string): boolean {
  return DEVICE_HTTP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * Authorize a bridge device for an HTTP request. Returns the device id on a hit
 * (token valid, active, AND the path is device-allowed), else null. Only
 * consulted when the bridge is enabled; off ⇒ no device tokens exist.
 */
export function authorizeDeviceHttp(token: string, pathname: string): { deviceId: string } | null {
  if (!isBridgeEnabled() || !token) return null;
  if (!isDeviceAllowedPath(pathname)) return null;
  const device = getDeviceRegistry().authenticate(token);
  return device ? { deviceId: device.id } : null;
}

// ── Live device-connection registry (for instant revocation) ──
// Maps deviceId → set of open WS sockets opened by that device. On revoke we
// close every live socket so the phone drops immediately rather than running
// until its next request fails.
const liveByDevice = new Map<string, Set<WebSocket>>();

export function trackDeviceSocket(deviceId: string, ws: WebSocket): void {
  let set = liveByDevice.get(deviceId);
  if (!set) { set = new Set(); liveByDevice.set(deviceId, set); }
  set.add(ws);
  ws.on("close", () => {
    const s = liveByDevice.get(deviceId);
    if (!s) return;
    s.delete(ws);
    if (s.size === 0) liveByDevice.delete(deviceId);
  });
}

/** Close every live socket for a device. Returns how many were closed. */
export function closeDeviceSockets(deviceId: string): number {
  const set = liveByDevice.get(deviceId);
  if (!set) return 0;
  let n = 0;
  for (const ws of set) {
    try { ws.close(WS_UNAUTHORIZED, "Device revoked"); n++; } catch { /* already dead */ }
  }
  liveByDevice.delete(deviceId);
  if (n > 0) logger.info(`[upgrade-auth] closed ${n} live socket(s) for revoked device ${deviceId}`);
  return n;
}

/** Test seam — drop all tracked sockets. */
export function clearLiveSocketsForTest(): void {
  liveByDevice.clear();
}
