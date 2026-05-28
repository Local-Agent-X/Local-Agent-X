import { promises as dns } from "node:dns";
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import type { SecretsStore } from "../secrets.js";
import { ok, err } from "./result-helpers.js";
import { checkOutboundRequest } from "./http-egress-guard.js";

async function dnsPin(url: string): Promise<string | null> {
  try {
    const host = new URL(url).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;

    const addrs = await dns.resolve4(host).catch(() => [] as string[]);
    for (const ip of addrs) {
      const parts = ip.split(".").map(Number);
      const [a, b] = parts;
      if (a === 127 || a === 10 || a === 0 || a >= 224) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 192 && b === 168) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 172 && b >= 16 && b <= 31) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 169 && b === 254) return `DNS rebinding blocked: ${host} → ${ip}`;
    }
  } catch { /* DNS failure is ok — might be valid host */ }
  return null;
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

    const pinResult = await dnsPin(url);
    if (pinResult) return err(pinResult, { url, duration_ms: Date.now() - startMs, dns_pin: "blocked" });

    try {
      let currentUrl = url;
      const doFetch = async () => {
        let r = await fetch(currentUrl, {
          headers: {
            "User-Agent": "LocalAgentX/0.1",
            Accept: "text/html,application/json,text/plain",
          },
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        });
        let redirects = 0;
        while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirects < 5) {
          currentUrl = new URL(r.headers.get("location")!, currentUrl).toString();
          const redirectPin = await dnsPin(currentUrl);
          if (redirectPin) throw new Error(`Redirect blocked: ${redirectPin}`);
          r = await fetch(currentUrl, {
            headers: { "User-Agent": "LocalAgentX/0.1", Accept: "text/html,application/json,text/plain" },
            signal: AbortSignal.timeout(30_000),
            redirect: "manual",
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

      const pinResult = await dnsPin(url);
      if (pinResult) return err(pinResult, { url, method, dns_pin: "blocked" });

      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      if (!validMethods.includes(method)) {
        return err(`Invalid HTTP method: ${method}. Must be one of: ${validMethods.join(", ")}`, {
          recovery: "Use one of the valid methods.",
        });
      }

      const guard = checkOutboundRequest({ url, method, body: args.body, headers: args.headers });
      if (guard) return err(guard.message, guard.meta);

      let autoAuth = false;
      try {
        const { getRuntimeConfig } = await import("../config.js");
        const rc = getRuntimeConfig();
        const selfUrl = `http://127.0.0.1:${rc.port}`;
        if (url.startsWith(selfUrl) || url.startsWith(`http://localhost:${rc.port}`)) {
          autoAuth = true;
        }
      } catch {}

      const headers: Record<string, string> = {
        "User-Agent": "LocalAgentX/0.1",
      };
      if (autoAuth) {
        try {
          const { getRuntimeConfig } = await import("../config.js");
          headers["Authorization"] = `Bearer ${getRuntimeConfig().authToken}`;
        } catch {}
      }
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

      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
        redirect: "manual",
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
          let r = await fetch(currentUrl, fetchOpts);
          let redirectCount = 0;

          while (r.status >= 300 && r.status < 400 && r.headers.get("location") && redirectCount < MAX_REDIRECTS) {
            const location = new URL(r.headers.get("location")!, currentUrl).toString();
            const origOrigin = new URL(currentUrl).origin;
            const newOrigin = new URL(location).origin;

            const redirectPin = await dnsPin(location);
            if (redirectPin) throw new Error(`Redirect blocked: ${redirectPin}`);

            const redirectHeaders = { ...headers };
            if (origOrigin !== newOrigin) {
              for (const h of SENSITIVE_HEADERS) {
                for (const key of Object.keys(redirectHeaders)) {
                  if (key.toLowerCase() === h) delete redirectHeaders[key];
                }
              }
            }

            currentUrl = location;
            r = await fetch(currentUrl, {
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
      }
    },
  };
}
