import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import { getLaxDir } from "../lax-data-dir.js";

import { createLogger } from "../logger.js";
import {
  LOCAL_SERVICE_RECOVERY,
  isPrivateIPv4,
  isPrivateIPv6,
  BLOCKED_HOSTNAMES,
} from "./ip-classification.js";

const logger = createLogger("security.network-policy");

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
  localServicePorts: ReadonlySet<string> = new Set<string>(),
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

  // Allow health-checks to operator-trusted local services (e.g. a bridge or
  // dev server the agent itself started). Literal loopback only — hostnames are
  // never resolved here, preserving DNS-rebinding protection.
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    if (parsed.port && localServicePorts.has(parsed.port)) {
      return { allowed: true, reason: "Allowed local service" };
    }
  }

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { allowed: false, reason: `Blocked: ${host} is a blocked hostname (SSRF protection)`, userHint: USER_HINTS.network, recovery: LOCAL_SERVICE_RECOVERY };
  }

  // Check if it's a literal IP address
  // IPv4 — strict decimal only; octal (0177.0.0.1) and hex (0x7f.0.0.1) are blocked
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || /^0x[0-9a-f]/i.test(host) || /^0[0-7]+\./.test(host)) {
    if (isPrivateIPv4(host)) {
      return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv4 address`, userHint: USER_HINTS.network, recovery: LOCAL_SERVICE_RECOVERY };
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
      return { allowed: false, reason: `Blocked: ${host} is a private/reserved IPv6 address`, userHint: USER_HINTS.network, recovery: LOCAL_SERVICE_RECOVERY };
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

/** Egress policy config as loaded from disk, in the shape evaluateWebFetch wants. */
export interface EgressConfig {
  allowlist: Set<string>;
  configured: boolean;
  mode: EgressMode;
  localServicePorts: Set<string>;
}

/**
 * Load the current egress policy from `getLaxDir()`:
 *   - egress-allowlist.json → allowlist (lowercased) + configured flag
 *   - security.json         → egressMode + localServicePorts
 *
 * Mirrors the SecurityLayer constructor's load semantics exactly (same
 * filenames, same lowercase normalization, same permissive default, same
 * fail-soft on any read/parse error). Self-contained — it does NOT depend on
 * a SecurityLayer instance — so it can be reused to re-check a URL outside the
 * pre-dispatch gate (e.g. a cross-host redirect target in web-tools.ts).
 *
 * NOTE: intentionally a standalone loader rather than an extraction of the
 * constructor body. The constructor sets instance fields and emits info logs
 * as a side effect; rewiring it to consume this would be a larger, riskier
 * change than the H5 follow-up warrants. Both paths share the same disk
 * format, so they stay consistent by construction.
 */
export function loadEgressConfig(): EgressConfig {
  const dir = getLaxDir();

  let allowlist = new Set<string>();
  let configured = false;
  try {
    const allowlistPath = join(dir, "egress-allowlist.json");
    if (existsSync(allowlistPath)) {
      const parsed = JSON.parse(readFileSync(allowlistPath, "utf-8"));
      if (Array.isArray(parsed)) {
        allowlist = new Set(parsed.map((d: unknown) => String(d).toLowerCase()));
        configured = true;
      }
    }
  } catch (e) {
    logger.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
  }

  let mode: EgressMode = "permissive";
  const localServicePorts = new Set<string>();
  try {
    const cfgPath = join(dir, "security.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.egressMode === "strict" || cfg.egressMode === "permissive") {
        mode = cfg.egressMode;
      }
      if (Array.isArray(cfg.localServicePorts)) {
        for (const p of cfg.localServicePorts) {
          const n = Number(p);
          if (Number.isInteger(n) && n > 0 && n <= 65535) localServicePorts.add(String(n));
        }
      }
    }
  } catch {}

  return { allowlist, configured, mode, localServicePorts };
}

/**
 * Re-run the egress policy against a single URL using the current on-disk
 * config. Used by the web-tools redirect loops to re-check a cross-host
 * redirect target against the egress allowlist BEFORE following it — the
 * pre-dispatch SecurityLayer gate only ever saw the INITIAL url, so without
 * this an allowlisted host could 302 to a non-allowlisted host in strict mode
 * (egress-allowlist bypass via redirect). Fails closed: any decision that
 * isn't `allowed` stops the redirect.
 *
 * selfPort defaults to "7007" (the SecurityLayer default) so a redirect that
 * loops back to our own server still resolves as a self-call.
 */
export function evaluateEgressForUrl(url: string, selfPort = "7007"): SecurityDecision {
  const cfg = loadEgressConfig();
  return evaluateWebFetch(
    cfg.allowlist,
    cfg.configured,
    selfPort,
    url,
    cfg.mode,
    cfg.localServicePorts,
  );
}

/** Resolve a hostname to a single validated public IP for connection pinning.
 *  - Literal IPv4/IPv6 (host is already an IP): validated synchronously here —
 *    a private/reserved/metadata literal is BLOCKED (ok: false), a public literal
 *    returns { ok: true, pin: null } (nothing to resolve). This guard runs on
 *    EVERY redirect hop, so a 302 to e.g. 169.254.169.254 can't slip through
 *    (evaluateWebFetch only validates the original pre-redirect URL).
 *  - Hostname: resolves A + AAAA; if ANY resolved address is private/reserved,
 *    blocks (DNS-rebinding protection); otherwise returns the first valid
 *    address as the pin (prefer IPv4 if present, else IPv6).
 *  - DNS failure: fail-closed (ok: false). */
export async function resolveAndPinHost(host: string): Promise<
  | { ok: true; pin: { address: string; family: 4 | 6 } | null }
  | { ok: false; reason: string }
> {
  // Literal IP — nothing to resolve, but it MUST still be checked for
  // private/reserved/metadata ranges before we allow the connection. Treat a
  // host containing ":" as an IPv6 literal, matching the existing
  // validateUrlWithDns guard.
  const ipVersion = isIP(host);

  // IPv4 literal (dotted-quad).
  if (ipVersion === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) {
      return {
        ok: false,
        reason: `Blocked: literal private/reserved IP ${host} (SSRF protection)`,
      };
    }
    return { ok: true, pin: null };
  }

  // IPv6 literal (may arrive bracketed as [::1]). Mirror the bracket-strip +
  // v4-mapped handling used by evaluateWebFetch above.
  if (ipVersion === 6 || host.includes(":")) {
    const cleanHost = host.replace(/^\[/, "").replace(/\]$/, "");
    if (isPrivateIPv6(cleanHost)) {
      return {
        ok: false,
        reason: `Blocked: literal private/reserved IP ${host} (SSRF protection)`,
      };
    }
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
  localServicePorts: ReadonlySet<string> = new Set<string>(),
): Promise<SecurityDecision> {
  // First do the synchronous check
  const syncResult = evaluateWebFetch(egressAllowlist, egressAllowlistConfigured, selfPort, url, egressMode, localServicePorts);
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
