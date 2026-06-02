import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("security.network-policy");

// ── SSRF: IP address validation helpers ──

/** Strictly parse a decimal IPv4 address — rejects octal (0177) and hex (0x7f) formats */
function parseStrictIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    // Reject octal (leading zeros) and hex (0x prefix) — only strict decimal
    if (!/^\d+$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const n = Number(part);
    if (isNaN(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/** Check if an IPv4 address is private/loopback/link-local/reserved */
function isPrivateIPv4(ip: string): boolean {
  const parts = parseStrictIPv4(ip);
  if (!parts) return true; // malformed or non-decimal → block (fail-closed)

  const [a, b] = parts;
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8 private
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a >= 224) return true;                           // multicast + reserved (224+)
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  return false;
}

/** Normalize an IPv6 address to its canonical compressed form */
function normalizeIPv6(ip: string): string {
  const cleaned = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // Expand :: notation to full form, then re-compress
  let groups: string[];
  if (cleaned.includes("::")) {
    const [left, right] = cleaned.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    groups = cleaned.split(":");
  }
  // Normalize each group (strip leading zeros)
  groups = groups.map(g => (parseInt(g, 16) || 0).toString(16));
  // Re-compress: find longest run of zeros
  const full = groups.join(":");
  return full;
}

/** Check if an IPv6 address is private/loopback/link-local */
function isPrivateIPv6(ip: string): boolean {
  const normalized = normalizeIPv6(ip);

  // Loopback (::1 and all equivalent forms like 0:0:0:0:0:0:0:1)
  if (normalized === "0:0:0:0:0:0:0:1" || normalized === "::1") return true;
  // Unspecified (:: and 0:0:0:0:0:0:0:0)
  if (normalized === "0:0:0:0:0:0:0:0" || normalized === "::") return true;
  // Link-local
  if (normalized.startsWith("fe80:") || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // Unique local (fc00::/7)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check original form for dotted notation
  const original = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const v4mapped = original.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);

  // IPv4-mapped IPv6 hex form (::ffff:7f00:1 = 127.0.0.1)
  const v4mappedHex = normalized.match(/^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(reconstructed);
  }

  // IPv4-compatible IPv6 (::a.b.c.d)
  const v4compat = original.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4compat) return isPrivateIPv4(v4compat[1]);

  return false;
}

/** Blocked hostnames (loopback aliases, cloud metadata) */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.internal",
  "metadata",
  "instance-data",                        // AWS EC2 metadata alias
  "kubernetes.default.svc",               // K8s in-cluster API
  "kubernetes.default",                    // K8s in-cluster API
]);

export type EgressMode = "permissive" | "strict";

/**
 * Match a hostname against the egress list (exact host or *.domain.com wildcard).
 * Rejects overly broad wildcards (*.com, *.org) — wildcard must have ≥2 labels.
 */
export function matchEgressList(host: string, list: ReadonlySet<string>): boolean {
  if (list.has(host)) return true;
  for (const d of list) {
    if (!d.startsWith("*.")) continue;
    const baseDomain = d.slice(2);
    if (baseDomain.split(".").length < 2) continue;
    if (host === baseDomain || host.endsWith("." + baseDomain)) return true;
  }
  return false;
}

export function evaluateWebFetch(
  egressAllowlist: ReadonlySet<string>,
  egressAllowlistConfigured: boolean,
  selfPort: string,
  url: string,
  egressMode: EgressMode = "permissive",
): SecurityDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "Blocked: invalid URL", userHint: USER_HINTS.network };
  }

  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Blocked: protocol ${parsed.protocol} not allowed (only http/https)`, userHint: USER_HINTS.network };
  }

  const host = parsed.hostname.toLowerCase();

  // Allow requests to the agent's own server BEFORE any other checks.
  // The agent needs to call its own API for settings, theme, orgs, etc.
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    const port = String(selfPort || "7007");
    if (parsed.port === port || (!parsed.port && port === "80")) {
      return { allowed: true, reason: "Self-call to own server" };
    }
  }

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { allowed: false, reason: `Blocked: ${host} is a blocked hostname (SSRF protection)`, userHint: USER_HINTS.network };
  }

  // Check if it's a literal IP address
  // IPv4 — strict decimal only; octal (0177.0.0.1) and hex (0x7f.0.0.1) are blocked
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || /^0x[0-9a-f]/i.test(host) || /^0[0-7]+\./.test(host)) {
    if (isPrivateIPv4(host)) {
      return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv4 address`, userHint: USER_HINTS.network };
    }
  }
  // Block hex integer IPs (e.g., 0x7f000001 = 127.0.0.1)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    return { allowed: false, reason: `Blocked: hex-encoded IP address "${host}" (SSRF protection)`, userHint: USER_HINTS.network };
  }
  // Block long-form decimal IPs (e.g., 2130706433 = 127.0.0.1)
  if (/^\d{8,}$/.test(host)) {
    return { allowed: false, reason: `Blocked: decimal-encoded IP address "${host}" (SSRF protection)`, userHint: USER_HINTS.network };
  }

  // IPv6 (in URL, appears as [::1])
  if (host.startsWith("[") || host.includes(":")) {
    const cleanHost = host.replace(/^\[/, "").replace(/\]$/, "");
    if (host.startsWith("[") && !host.includes("]")) {
      return { allowed: false, reason: `Blocked: malformed IPv6 address brackets in ${host}`, userHint: USER_HINTS.network };
    }
    if (isPrivateIPv6(cleanHost)) {
      return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv6 address`, userHint: USER_HINTS.network };
    }
  }

  // Cloud metadata endpoints (various formats)
  if (host === "169.254.169.254" || host.endsWith(".internal") || host.endsWith(".metadata")) {
    return { allowed: false, reason: `Blocked: ${host} is a cloud metadata endpoint`, userHint: USER_HINTS.network };
  }

  // ── Egress policy ──
  // Permissive (default): all public hosts allowed. SSRF/private-IP/cloud-metadata
  // blocks above remain; allowlist (if present) gates secret-bearing requests
  // at the tool layer (web-tools.ts), not the network layer.
  //
  // Strict: deny-by-default; only allowlisted hosts pass. Missing file in
  // strict mode emits an actionable setup hint.
  if (egressMode === "strict") {
    if (!egressAllowlistConfigured) {
      return {
        allowed: false,
        reason:
          `Blocked: egress mode is "strict" but no allowlist configured. ` +
          `Create ~/.lax/egress-allowlist.json with a JSON array of allowed domains ` +
          `(e.g. ["api.anthropic.com","github.com","*.npmjs.org"]) or set egressMode to "permissive" in ~/.lax/security.json.`,
        userHint: USER_HINTS.network,
      };
    }
    if (!matchEgressList(host, egressAllowlist)) {
      return { allowed: false, reason: `Blocked: ${host} is not in the egress allowlist (strict mode). Add it to ~/.lax/egress-allowlist.json to permit.`, userHint: USER_HINTS.network };
    }
  }

  return { allowed: true, reason: "Web fetch allowed" };
}

/** Resolve a hostname to a single validated public IP for connection pinning.
 *  - Literal IPv4/IPv6 (host is already an IP): returns { ok: true, pin: null }
 *    — there is no DNS to pin; literal addresses are validated synchronously by
 *    evaluateWebFetch, and loopback self-calls are permitted there.
 *  - Hostname: resolves A + AAAA; if ANY resolved address is private/reserved,
 *    blocks (DNS-rebinding protection); otherwise returns the first valid
 *    address as the pin (prefer IPv4 if present, else IPv6).
 *  - DNS failure: fail-closed (ok: false). */
export async function resolveAndPinHost(host: string): Promise<
  | { ok: true; pin: { address: string; family: 4 | 6 } | null }
  | { ok: false; reason: string }
> {
  // Literal IP — nothing to resolve, nothing to pin. Treat a host containing
  // ":" as an IPv6 literal, matching the existing validateUrlWithDns guard.
  if (isIP(host) !== 0 || host.includes(":")) {
    return { ok: true, pin: null };
  }

  let addresses: string[];
  let addresses6: string[];
  try {
    addresses = await dns.resolve4(host).catch(() => []);
    addresses6 = await dns.resolve6(host).catch(() => []);
  } catch {
    addresses = [];
    addresses6 = [];
  }

  // Host doesn't resolve at all → fail-closed.
  if (addresses.length === 0 && addresses6.length === 0) {
    logger.warn(`[security] DNS resolution failed for ${host}: no A/AAAA records`);
    return {
      ok: false,
      reason: `Blocked: DNS resolution failed for ${host} (fail-closed SSRF protection)`,
    };
  }

  for (const ip of addresses) {
    if (isPrivateIPv4(ip)) {
      return {
        ok: false,
        reason: `Blocked: ${host} resolves to private IP ${ip} (DNS rebinding protection)`,
      };
    }
  }

  for (const ip of addresses6) {
    if (isPrivateIPv6(ip)) {
      return {
        ok: false,
        reason: `Blocked: ${host} resolves to private IPv6 ${ip} (DNS rebinding protection)`,
      };
    }
  }

  // Pin the first validated address — prefer IPv4 if present, else IPv6.
  if (addresses.length) {
    return { ok: true, pin: { address: addresses[0], family: 4 } };
  }
  return { ok: true, pin: { address: addresses6[0], family: 6 } };
}

/**
 * Async SSRF check with DNS pinning.
 * Resolves hostname to IP and validates the resolved address.
 * Call this for actual network requests (not just policy check).
 */
export async function validateUrlWithDns(
  egressAllowlist: ReadonlySet<string>,
  egressAllowlistConfigured: boolean,
  selfPort: string,
  url: string,
  egressMode: EgressMode = "permissive",
): Promise<SecurityDecision> {
  // First do the synchronous check
  const syncResult = evaluateWebFetch(egressAllowlist, egressAllowlistConfigured, selfPort, url, egressMode);
  if (!syncResult.allowed) return syncResult;

  const parsed = new URL(url);
  const host = parsed.hostname;

  // Skip DNS check for literal IPs (already validated above)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return syncResult;
  }

  // DNS pinning: resolve the hostname and validate the actual IP. One source of
  // truth for the resolve + private-IP check lives in resolveAndPinHost.
  const pinned = await resolveAndPinHost(host);
  if (!pinned.ok) {
    return { allowed: false, reason: pinned.reason, userHint: USER_HINTS.network };
  }

  return { allowed: true, reason: "Web fetch allowed (DNS validated)" };
}
