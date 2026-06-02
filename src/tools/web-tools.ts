import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import type { SecretsStore } from "../secrets.js";
import { ok, err } from "./result-helpers.js";
import { checkOutboundRequest } from "./http-egress-guard.js";
import { getInternalAgentToken } from "../rbac.js";
import { resolveAndPinHost } from "../security/network-policy.js";

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
 *  the connection if resolveAndPinHost rejects. Literal IPs pass through. */
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
          let r = await undiciFetch(currentUrl, fetchOpts);
          let redirectCount = 0;

          while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirectCount < MAX_REDIRECTS) {
            const location = new URL(r.headers.get("location")!, currentUrl).toString();
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
