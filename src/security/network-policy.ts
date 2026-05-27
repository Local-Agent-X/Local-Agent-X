import { promises as dns } from "node:dns";
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

export function evaluateWebFetch(
  egressAllowlist: ReadonlySet<string>,
  egressAllowlistConfigured: boolean,
  selfPort: string,
  url: string,
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

  // ── Egress domain allowlist ──
  // Deny-by-default. If no allowlist file is configured at all, refuse
  // outbound requests with an actionable setup hint — the alternative
  // (silently allowing every public host when the file is absent) makes
  // the advertised egress-allowlist feature a no-op on default installs.
  if (!egressAllowlistConfigured) {
    return {
      allowed: false,
      reason:
        `Blocked: no egress allowlist configured. ` +
        `Create ~/.lax/egress-allowlist.json with a JSON array of allowed domains ` +
        `(e.g. ["api.anthropic.com","github.com","*.npmjs.org"]) to permit outbound requests.`,
      userHint: USER_HINTS.network,
    };
  }
  const allowed = egressAllowlist.has(host) ||
    // Check wildcard subdomains: *.example.com matches sub.example.com
    // Require at least 2 labels in the wildcard domain (*.com is too broad)
    Array.from(egressAllowlist).some(d => {
      if (!d.startsWith("*.")) return false;
      const baseDomain = d.slice(2);
      // Reject overly broad wildcards like *.com, *.org, *.net
      if (baseDomain.split(".").length < 2) return false;
      return host === baseDomain || host.endsWith("." + baseDomain);
    });
  if (!allowed) {
    return { allowed: false, reason: `Blocked: ${host} is not in the egress allowlist. Add it to ~/.lax/egress-allowlist.json to permit.`, userHint: USER_HINTS.network };
  }

  return { allowed: true, reason: "Web fetch allowed" };
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
): Promise<SecurityDecision> {
  // First do the synchronous check
  const syncResult = evaluateWebFetch(egressAllowlist, egressAllowlistConfigured, selfPort, url);
  if (!syncResult.allowed) return syncResult;

  const parsed = new URL(url);
  const host = parsed.hostname;

  // Skip DNS check for literal IPs (already validated above)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return syncResult;
  }

  // DNS pinning: resolve the hostname and check the actual IP
  try {
    const addresses = await dns.resolve4(host).catch(() => []);
    const addresses6 = await dns.resolve6(host).catch(() => []);

    for (const ip of addresses) {
      if (isPrivateIPv4(ip)) {
        return {
          allowed: false,
          reason: `Blocked: ${host} resolves to private IP ${ip} (DNS rebinding protection)`,
          userHint: USER_HINTS.network,
        };
      }
    }

    for (const ip of addresses6) {
      if (isPrivateIPv6(ip)) {
        return {
          allowed: false,
          reason: `Blocked: ${host} resolves to private IPv6 ${ip} (DNS rebinding protection)`,
          userHint: USER_HINTS.network,
        };
      }
    }
  } catch (dnsErr) {
    // DNS resolution failed — fail closed for security (block unknown hosts)
    logger.warn(`[security] DNS resolution failed for ${host}: ${(dnsErr as Error).message}`);
    return {
      allowed: false,
      reason: `Blocked: DNS resolution failed for ${host} (fail-closed SSRF protection)`,
      userHint: USER_HINTS.network,
    };
  }

  return { allowed: true, reason: "Web fetch allowed (DNS validated)" };
}
