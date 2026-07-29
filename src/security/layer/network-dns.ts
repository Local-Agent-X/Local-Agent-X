/**
 * The DNS-resolution chokepoint of the egress layer: resolve a hostname, reject
 * it if ANY answer is private/reserved (DNS rebinding), and hand back a PIN so
 * the address that was CHECKED is the address that gets dialed.
 *
 * Split out of network-policy.ts (which sits at the 400-LOC gate) rather than
 * duplicated: network-policy re-exports this, so every existing importer — and
 * security/layer/index.ts — is unchanged. Imports only the pure classifiers, so
 * there is no cycle back into the policy module.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { createLogger } from "../../logger.js";
import { canonicalizeHost, isPrivateIPv4, isPrivateIPv6 } from "./ip-classification.js";

const logger = createLogger("security.network-dns");

/** Resolve a hostname to a single validated public IP for connection pinning.
 *  - Literal IPv4/IPv6 (host is already an IP): validated synchronously here —
 *    a private/reserved/metadata literal is BLOCKED (ok: false), a public literal
 *    returns { ok: true, pin: null } (nothing to resolve). This guard runs on
 *    EVERY redirect hop, so a 302 to e.g. 169.254.169.254 can't slip through
 *    (evaluateWebFetch only validates the original pre-redirect URL).
 *  - Hostname: resolves A + AAAA; if ANY resolved address is private/reserved,
 *    blocks (DNS-rebinding protection); otherwise returns the first valid
 *    address as the pin (prefer IPv4 if present, else IPv6).
 *  - DNS failure: fail-closed (ok: false).
 *
 *  NOTE: loopback stays fail-closed here even for the `localhost` alias family,
 *  because this function has no PORT context and therefore cannot apply the
 *  self-port / localServicePorts grant. Callers that legitimately dial a
 *  loopback alias authorize it against evaluateWebFetch (which does see the
 *  port) and skip this resolve — see web-egress.ts createPinningDispatcher. */
export async function resolveAndPinHost(host: string): Promise<
  | { ok: true; pin: { address: string; family: 4 | 6 } | null }
  | { ok: false; reason: string }
> {
  // Canonicalize once at ingest (lowercase + strip a single trailing dot) so a
  // trailing-dot hostname resolves/blocks identically to its dotless form.
  host = canonicalizeHost(host);

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
  // v4-mapped handling used by evaluateWebFetch.
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
