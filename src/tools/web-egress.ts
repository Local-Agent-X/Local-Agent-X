import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from "undici";
import { getInternalAgentToken } from "../rbac.js";
import { resolveAndPinHost, evaluateEgressForUrl } from "../security/network-policy.js";

/** Browser-like identity for agent web fetches. Many commerce/price sites
 *  (PriceCharting, TCGplayer, eBay) reject a non-browser User-Agent with an
 *  immediate HTTP 400/403, so a fetch that presents as a real browser reaches
 *  far more sources. Single source of truth — point tool fetchers here instead
 *  of re-hardcoding a UA string inline. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
export const BROWSER_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Thrown inside a redirect loop when a cross-host redirect target fails the
 *  egress policy re-check (strict-mode allowlist bypass via 302). Carries the
 *  policy reason so the tool can fail closed with an actionable message rather
 *  than a generic fetch error. */
export class EgressRedirectBlocked extends Error {
  constructor(public readonly blockedUrl: string, reason: string) {
    super(reason);
    this.name = "EgressRedirectBlocked";
  }
}

/** Re-run the egress policy on a redirect target when it crosses to a new host.
 *  Same-host redirects are not re-checked HERE for the egress allowlist (it is
 *  host-scoped and the origin was already gated pre-dispatch). Throws
 *  EgressRedirectBlocked if the new host is denied. Note: literal-IP SSRF is NOT
 *  covered by this cross-host short-circuit — it is enforced separately by
 *  assertLiteralIpEgressAllowed on EVERY hop (see below). */
export function assertRedirectEgressAllowed(fromUrl: string, toUrl: string): void {
  if (new URL(fromUrl).host === new URL(toUrl).host) return;
  const decision = evaluateEgressForUrl(toUrl);
  if (!decision.allowed) {
    throw new EgressRedirectBlocked(toUrl, decision.reason);
  }
}

/** Detect a literal IP host (IPv4 dotted-quad, or anything bracketed/colon-ish
 *  that the URL parser surfaced as an IPv6 literal). Hostnames go through the
 *  pinning dispatcher's connect.lookup; literals do NOT (undici skips the DNS
 *  lookup for an address), so they need a synchronous pre-connect SSRF check. */
function isLiteralIpHost(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** Synchronous pre-connect SSRF check for LITERAL-IP destinations, run before
 *  the initial fetch AND before following every redirect (same-host included).
 *
 *  This closes a real gap: the pinning dispatcher validates SSRF inside
 *  connect.lookup, but undici never calls connect.lookup for a literal IP — it
 *  dials the address directly — so resolveAndPinHost's literal branch is dead
 *  for the dispatcher path. Without this guard a literal private/metadata/NAT64
 *  /6to4 destination (initial URL or a 302 Location, even to the same host)
 *  would connect unchecked. Reuses the canonical evaluateEgressForUrl path so
 *  the same isPrivate* rules apply on every hop. Throws EgressRedirectBlocked
 *  (fail-closed) so callers surface an actionable reason. */
export async function assertLiteralIpEgressAllowed(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  } catch {
    throw new EgressRedirectBlocked(url, "Blocked: invalid URL (SSRF protection)");
  }
  if (!isLiteralIpHost(host)) return; // hostname → covered by the pinning dispatcher
  // Use the real runtime port so a legitimate loopback self-call (which targets
  // 127.0.0.1:<configured-port>) is still recognised as a self-call and allowed;
  // fall back to evaluateEgressForUrl's 7007 default if config isn't loaded.
  let selfPort = "7007";
  try {
    const { getRuntimeConfig } = await import("../config.js");
    selfPort = String(getRuntimeConfig().port);
  } catch {}
  const decision = evaluateEgressForUrl(url, selfPort);
  if (!decision.allowed) {
    throw new EgressRedirectBlocked(url, decision.reason);
  }
}

/** Auth header for a loopback self-call to our own server, or null for any
 *  external URL (so the token never leaks off-box). Uses the least-privilege
 *  internal agent token; falls back to the operator token only when the
 *  internal token is unset (e.g. a subprocess that didn't boot the full
 *  server — it already holds the operator token on disk and runs at full
 *  user trust). In the main server process the internal token is always set,
 *  so the agent loop never wields operator for its own self-calls. */
export async function selfCallAuthHeader(url: string): Promise<Record<string, string> | null> {
  let rc;
  try {
    const { getRuntimeConfig } = await import("../config.js");
    rc = getRuntimeConfig();
  } catch {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (!isLoopback || parsed.port !== String(rc.port)) return null;
  const token = getInternalAgentToken() ?? rc.authToken;
  return { Authorization: `Bearer ${token}` };
}

/** Callback shape undici's `connect.lookup` invokes — the array form, where a
 *  validated address is returned as `[{ address, family }]`. Typed locally
 *  because undici's `connect` lookup option carries the loose node:net
 *  signature and won't otherwise accept the array callback without a cast. */
type PinLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: { address: string; family: 4 | 6 }[],
) => void;

/** A dispatcher whose DNS lookup resolves, validates against SSRF/private-IP
 *  rules, and pins the socket to the validated IP — at connect time, so the
 *  IP that is checked is the IP that is dialed (no rebinding TOCTOU). Blocks
 *  the connection if resolveAndPinHost rejects.
 *
 *  IMPORTANT: this validates HOSTNAMES only. undici does not invoke
 *  connect.lookup for a literal IP destination — it dials the address
 *  directly — so the literal-IP branch here never runs for the dispatcher
 *  path. Literal-IP SSRF is therefore enforced synchronously before connect by
 *  assertLiteralIpEgressAllowed, called on the initial URL and every redirect
 *  hop. (The literal pass-through below remains for the rare case undici does
 *  hand us a literal, and to keep this dispatcher self-consistent.) */
export function createPinningDispatcher(): Agent {
  return new Agent({
    connect: {
      lookup: (hostname: string, _opts: unknown, cb: PinLookupCallback) => {
        resolveAndPinHost(hostname).then((r) => {
          if (!r.ok) { cb(new Error(r.reason), []); return; }
          if (r.pin === null) {
            const family = hostname.includes(":") ? 6 : 4;
            cb(null, [{ address: hostname, family }]);
          } else {
            cb(null, [{ address: r.pin.address, family: r.pin.family }]);
          }
        }).catch((e) => cb(e instanceof Error ? e : new Error(String(e)), []));
      },
    },
  });
}

export interface CanonicalFetchOptions {
  /** Request headers (merged as-is; no secret resolution here). */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Max redirect hops to follow before failing (default 5). */
  maxRedirects?: number;
}

/** Schemes a canonicalFetch is allowed to dial. A redirect that bounces to
 *  file:/data:/gopher:/etc. must fail closed — only http(s) goes through the
 *  pinning dispatcher's SSRF gate, so anything else is an egress bypass. */
function assertHttpScheme(url: string): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new EgressRedirectBlocked(url, "Blocked: invalid URL (SSRF protection)");
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new EgressRedirectBlocked(url, `Blocked: scheme ${scheme} not allowed (SSRF protection)`);
  }
}

/** The ONE hardened, SSRF-pinned fetch used wherever an internal-kernel tool
 *  reaches the network without the dispatch-time evaluateWebFetch gate (e.g.
 *  content-tool image acquisition). Ties together the SAME exported primitives
 *  web_fetch / http_request use inline — createPinningDispatcher (DNS-pin +
 *  private-IP block at connect, no TOCTOU), assertLiteralIpEgressAllowed
 *  (synchronous literal-IP SSRF the dispatcher can't see) and
 *  assertRedirectEgressAllowed (cross-host allowlist re-check) — driven through
 *  a MANUAL per-hop redirect loop that re-validates EVERY hop (scheme +
 *  literal-IP + DNS-pin) before connecting. Fails CLOSED (throws
 *  EgressRedirectBlocked, or the dispatcher's connect error) on any disallowed
 *  host, bad scheme, or DNS failure for a non-loopback host.
 *
 *  Returns the final undici Response. The caller owns size/MIME/timeout-of-body
 *  concerns; this is purely the network + SSRF layer. */
export async function canonicalFetch(
  url: string,
  opts: CanonicalFetchOptions = {},
): Promise<UndiciResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const dispatcher = createPinningDispatcher();
  try {
    let currentUrl = url;
    const fetchOpts: UndiciRequestInit = {
      headers: opts.headers ?? {},
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      dispatcher,
    };

    // Pre-connect scheme + literal-IP SSRF check on the INITIAL url (the pinning
    // dispatcher's connect.lookup never fires for a literal IP).
    assertHttpScheme(currentUrl);
    await assertLiteralIpEgressAllowed(currentUrl);
    let r = await undiciFetch(currentUrl, fetchOpts);

    let redirects = 0;
    while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirects < maxRedirects) {
      const location = new URL(r.headers.get("location")!, currentUrl).toString();
      // Validate the redirect target BEFORE following: scheme, cross-host egress
      // allowlist, and literal-IP SSRF on every hop (same-host included — a 302
      // to a literal private/metadata/NAT64/6to4 IP bypasses the dispatcher).
      assertHttpScheme(location);
      assertRedirectEgressAllowed(currentUrl, location);
      await assertLiteralIpEgressAllowed(location);
      currentUrl = location;
      r = await undiciFetch(currentUrl, fetchOpts);
      redirects++;
    }
    return r;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
