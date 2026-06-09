import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import type { SecretsStore } from "../secrets.js";
import { ok, err } from "./result-helpers.js";
import { checkOutboundRequest } from "./http-egress-guard.js";
import { getInternalAgentToken } from "../rbac.js";
import { resolveAndPinHost, evaluateEgressForUrl } from "../security/network-policy.js";

/** Thrown inside a redirect loop when a cross-host redirect target fails the
 *  egress policy re-check (strict-mode allowlist bypass via 302). Carries the
 *  policy reason so the tool can fail closed with an actionable message rather
 *  than a generic fetch error. */
class EgressRedirectBlocked extends Error {
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
function assertRedirectEgressAllowed(fromUrl: string, toUrl: string): void {
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
async function assertLiteralIpEgressAllowed(url: string): Promise<void> {
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

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a URL and return its text content. Useful for reading web pages and APIs.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url);
    const startMs = Date.now();

    const dispatcher = createPinningDispatcher();
    try {
      let currentUrl = url;
      // Loopback self-call auth (least-privilege internal token). Dropped on any
      // cross-origin redirect so the token never leaves this server.
      let selfAuth = await selfCallAuthHeader(url);
      const doFetch = async () => {
        // Pre-connect literal-IP SSRF check (undici's connect.lookup, where the
        // pinning dispatcher validates, never fires for a literal IP).
        await assertLiteralIpEgressAllowed(currentUrl);
        let r = await undiciFetch(currentUrl, {
          headers: {
            "User-Agent": "LocalAgentX/0.1",
            Accept: "text/html,application/json,text/plain",
            ...selfAuth,
          },
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
          dispatcher,
        });
        let redirects = 0;
        while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirects < 5) {
          const location = new URL(r.headers.get("location")!, currentUrl).toString();
          // Re-check the egress policy on a cross-host redirect: the pre-dispatch
          // gate only validated the initial URL, so an allowlisted host could
          // 302 to a non-allowlisted host in strict mode. Fail closed.
          assertRedirectEgressAllowed(currentUrl, location);
          // Literal-IP SSRF on every hop, same-host included (a 302 to a literal
          // private/metadata/NAT64/6to4 IP bypasses the pinning dispatcher).
          await assertLiteralIpEgressAllowed(location);
          if (selfAuth && new URL(currentUrl).origin !== new URL(location).origin) selfAuth = null;
          currentUrl = location;
          r = await undiciFetch(currentUrl, {
            headers: { "User-Agent": "LocalAgentX/0.1", Accept: "text/html,application/json,text/plain", ...selfAuth },
            signal: AbortSignal.timeout(30_000),
            redirect: "manual",
            dispatcher,
          });
          redirects++;
        }
        return r;
      };

      let res = await doFetch();
      const RETRYABLE = [429, 503, 504];
      for (let attempt = 1; attempt <= 3 && RETRYABLE.includes(res.status); attempt++) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
        await new Promise(r => setTimeout(r, delay));
        res = await doFetch();
      }

      const durationMs = Date.now() - startMs;
      if (!res.ok && !(res.status >= 300 && res.status < 400)) {
        // Recovery hint inline in the error string so the agent's LLM
        // sees a clear next action instead of inferring one. Without
        // this hint, agents tend to give up after 2-3 failed fetches
        // rather than pivot — see src/agents/result-guard.ts for the
        // failure mode this addresses.
        const recoveryHint = res.status >= 400
          ? " — source unavailable. Try web_search for alternative URLs, or fetch a different source. Don't give up; report what you couldn't reach as a limitation."
          : "";
        return err(`HTTP ${res.status}: ${res.statusText}${recoveryHint}`, {
          url: currentUrl,
          status: res.status,
          duration_ms: durationMs,
        });
      }

      let body = await res.text();

      const MAX_CHARS = 50_000;
      const fullBytes = body.length;
      const truncated = fullBytes > MAX_CHARS;
      if (truncated) {
        body = body.slice(0, MAX_CHARS) + `\n\n[Truncated at ${MAX_CHARS} chars]`;
      }

      return ok(wrapExternalContent(body, "web_fetch", { url, status: String(res.status) }), {
        url: currentUrl,
        status: res.status,
        duration_ms: durationMs,
        bytes: fullBytes,
        truncated: truncated || undefined,
      });
    } catch (e) {
      if (e instanceof EgressRedirectBlocked) {
        return err(e.message, { url, blocked_url: e.blockedUrl, duration_ms: Date.now() - startMs });
      }
      return err(`Fetch failed: ${(e as Error).message}`, { url, duration_ms: Date.now() - startMs });
    } finally {
      await dispatcher.close().catch(() => {});
    }
  },
};

export function createHttpRequestTool(secrets?: SecretsStore): ToolDefinition {
  return {
    name: "http_request",
    description:
      "Make a full HTTP request to any API. Supports all methods, custom headers, authentication, and request bodies. " +
      "Use {{SECRET_NAME}} syntax in header values to securely inject stored secrets (e.g. \"Authorization\": \"Bearer {{GITHUB_TOKEN}}\"). " +
      "Use request_secret first if the needed secret isn't stored yet. " +
      "Use this to integrate with external services (GitHub, Slack, Jira, Linear, Discord, REST/GraphQL APIs, etc.).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: {
          type: "string",
          description: "HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS (default: GET)",
        },
        headers: {
          type: "object",
          description:
            'Custom headers as key-value pairs. Use {{SECRET_NAME}} for stored secrets. Example: { "Authorization": "Bearer {{GITHUB_TOKEN}}" }',
        },
        body: {
          type: "string",
          description:
            "Request body as a string. Supports {{SECRET_NAME}} placeholders. For JSON APIs, pass a JSON string and set Content-Type header to application/json.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000 = 30s, max: 120000 = 2min)",
        },
      },
      required: ["url"],
    },
    async execute(args) {
      const url = String(args.url);
      const method = String(args.method || "GET").toUpperCase();
      const timeout = Math.min((args.timeout as number) || 30_000, 120_000);
      const startMs = Date.now();

      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      if (!validMethods.includes(method)) {
        return err(`Invalid HTTP method: ${method}. Must be one of: ${validMethods.join(", ")}`, {
          recovery: "Use one of the valid methods.",
        });
      }

      const guard = checkOutboundRequest({ url, method, body: args.body, headers: args.headers });
      if (guard) return err(guard.message, guard.meta);

      const headers: Record<string, string> = {
        "User-Agent": "LocalAgentX/0.1",
      };
      // Loopback self-calls authenticate with the least-privilege internal agent
      // token (null for any external host, so it never leaks off-box). The
      // cross-origin redirect stripping below removes `authorization` if a self
      // redirect ever crosses to another origin.
      const selfAuth = await selfCallAuthHeader(url);
      if (selfAuth) Object.assign(headers, selfAuth);
      if (args.headers && typeof args.headers === "object") {
        for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
          let resolved = String(value);
          if (secrets) {
            const missing = secrets.findMissing(resolved);
            if (missing.length > 0) {
              return err(
                `Missing secrets: ${missing.join(", ")}. Use request_secret to ask the user for these credentials first.`
              );
            }
            resolved = secrets.resolve(resolved);
          }
          headers[String(key)] = resolved;
        }
      }

      let bodyStr = args.body ? String(args.body) : undefined;
      if (bodyStr && secrets) {
        const missing = secrets.findMissing(bodyStr);
        if (missing.length > 0) {
          return err(
            `Missing secrets in body: ${missing.join(", ")}. Use request_secret to ask the user for these credentials first.`
          );
        }
        bodyStr = secrets.resolve(bodyStr);
      }

      const dispatcher = createPinningDispatcher();
      const fetchOpts: UndiciRequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
        redirect: "manual",
        dispatcher,
      };

      if (bodyStr && method !== "GET" && method !== "HEAD") {
        fetchOpts.body = bodyStr;
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }

      try {
        const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key"];
        const MAX_REDIRECTS = 5;
        let currentUrl = url;

        const doFetch = async () => {
          // Pre-connect literal-IP SSRF check (the pinning dispatcher's
          // connect.lookup never fires for a literal IP).
          await assertLiteralIpEgressAllowed(currentUrl);
          let r = await undiciFetch(currentUrl, fetchOpts);
          let redirectCount = 0;

          while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirectCount < MAX_REDIRECTS) {
            const location = new URL(r.headers.get("location")!, currentUrl).toString();
            // Re-check the egress policy on a cross-host redirect (strict-mode
            // allowlist bypass via 302). Fail closed before following.
            assertRedirectEgressAllowed(currentUrl, location);
            // Literal-IP SSRF on every hop, same-host included (a 302 to a
            // literal private/metadata/NAT64/6to4 IP bypasses the dispatcher).
            await assertLiteralIpEgressAllowed(location);
            const origOrigin = new URL(currentUrl).origin;
            const newOrigin = new URL(location).origin;

            const redirectHeaders = { ...headers };
            if (origOrigin !== newOrigin) {
              for (const h of SENSITIVE_HEADERS) {
                for (const key of Object.keys(redirectHeaders)) {
                  if (key.toLowerCase() === h) delete redirectHeaders[key];
                }
              }
            }

            currentUrl = location;
            r = await undiciFetch(currentUrl, {
              ...fetchOpts,
              headers: redirectHeaders,
              body: r.status === 303 ? undefined : fetchOpts.body,
              method: r.status === 303 ? "GET" : method,
            });
            redirectCount++;
          }
          return r;
        };

        let res = await doFetch();
        const RETRYABLE = [429, 503, 504];
        for (let attempt = 1; attempt <= 3 && RETRYABLE.includes(res.status); attempt++) {
          const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
          await new Promise(r => setTimeout(r, delay));
          res = await doFetch();
        }

        const statusLine = `${res.status} ${res.statusText}`;

        const resHeaders: string[] = [];
        res.headers.forEach((value, key) => {
          resHeaders.push(`${key}: ${value}`);
        });

        const durationMs = Date.now() - startMs;
        if (method === "HEAD") {
          return ok(`HTTP ${statusLine}\n\n${resHeaders.join("\n")}`, {
            url: currentUrl,
            method,
            status: res.status,
            duration_ms: durationMs,
          });
        }

        let body = await res.text();

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            // Keep raw body
          }
        }

        const MAX_CHARS = 100_000;
        const fullBytes = body.length;
        const truncated = fullBytes > MAX_CHARS;
        if (truncated) {
          body = body.slice(0, MAX_CHARS) + `\n\n[Truncated at ${MAX_CHARS} chars]`;
        }

        const wrapped = wrapExternalContent(body, "http_request", {
          url,
          method,
          status: statusLine,
        });
        const output = `HTTP ${statusLine}\n\n${wrapped}`;
        const meta = {
          url: currentUrl,
          method,
          status: res.status,
          duration_ms: durationMs,
          bytes: fullBytes,
          truncated: truncated || undefined,
          content_type: contentType || undefined,
        };
        return res.ok ? ok(output, meta) : err(output, meta);
      } catch (e) {
        if (e instanceof EgressRedirectBlocked) {
          return err(e.message, {
            url,
            method,
            blocked_url: e.blockedUrl,
            duration_ms: Date.now() - startMs,
          });
        }
        return err(`HTTP request failed: ${(e as Error).message}`, {
          url,
          method,
          duration_ms: Date.now() - startMs,
        });
      } finally {
        await dispatcher.close().catch(() => {});
      }
    },
  };
}
