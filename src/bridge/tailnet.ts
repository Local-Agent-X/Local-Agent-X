// Tailnet interface detection for the mobile bridge.
//
// Tailscale assigns every node a stable IP in the 100.64.0.0/10 CGNAT range
// (RFC 6598). When the bridge is enabled we bind the existing HTTP/WS server to
// THIS interface (in addition to loopback) so a paired phone on the same
// tailnet can reach it — never the public internet (constitution §6).
//
// Detection is best-effort: if no tailnet address is found, the caller can fall
// back to a configurable bind address (LAX_BRIDGE_BIND_ADDR). We never
// auto-bind to 0.0.0.0.

import { networkInterfaces } from "node:os";

/** True if `ip` is an IPv4 address inside Tailscale's 100.64.0.0/10 CGNAT block. */
export function isTailnetAddr(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  // 100.64.0.0/10 → first octet 100, second octet 64-127.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Find this machine's Tailscale CGNAT address, or null if none is up. Skips
 * internal/loopback interfaces and IPv6 (the prototype transport is IPv4 over
 * the tailnet).
 */
export function detectTailnetAddr(): string | null {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isTailnetAddr(a.address)) return a.address;
    }
  }
  return null;
}

/** True if `origin` (an HTTP Origin header value) names a tailnet-CGNAT host.
 *  Used to admit a future webview client served from the desktop's tailnet
 *  address; non-browser mobile clients send no Origin and don't need this. */
export function isTailnetOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return isTailnetAddr(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the address the bridge should bind to. Prefers a detected tailnet
 * address; otherwise honors an explicit override (LAX_BRIDGE_BIND_ADDR) so a
 * relay/VPN with a non-CGNAT address can still be used deliberately. Returns
 * null when neither is available — the caller logs and skips the bridge bind
 * rather than guessing a public interface.
 */
export function resolveBridgeBindAddr(override?: string): string | null {
  const detected = detectTailnetAddr();
  if (detected) return detected;
  const trimmed = (override ?? "").trim();
  if (trimmed) return trimmed;
  return null;
}
