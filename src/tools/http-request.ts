import { fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type { ToolDefinition } from "../types.js";
import { isRetryableTool } from "../resilience-policy.js";
import { wrapExternalContent } from "../sanitize.js";
import { findInBody } from "./paginate-body.js";
import type { SecretsStore } from "../secrets.js";
import { ok, err } from "./result-helpers.js";
import { capWithSpill } from "./result-spill.js";
import { checkOutboundRequest } from "./http-egress-guard.js";
import {
  EgressRedirectBlocked,
  assertRedirectEgressAllowed,
  assertLiteralIpEgressAllowed,
  selfCallAuthHeader,
  createPinningDispatcher,
  BROWSER_USER_AGENT,
} from "./web-egress.js";

export function createHttpRequestTool(secrets?: SecretsStore): ToolDefinition {
  const tool: ToolDefinition = {
    name: "http_request",
    effect: (args) => {
      const method = String(args.method || "GET").toUpperCase();
      if (["GET", "HEAD", "OPTIONS"].includes(method)) return { class: "read-only" };
      const headers = args.headers && typeof args.headers === "object"
        ? args.headers as Record<string, unknown>
        : {};
      const keyEntry = Object.entries(headers).find(([name]) =>
        ["idempotency-key", "x-idempotency-key"].includes(name.toLowerCase()),
      );
      const rawKey = args.idempotency_key ?? keyEntry?.[1];
      const operationKey = typeof rawKey === "string" ? rawKey.trim() : "";
      return operationKey ? { class: "keyed-mutation", operationKey } : { class: "non-idempotent" };
    },
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
        idempotency_key: {
          type: "string",
          description: "Stable operation key for safely retrying a mutation after a transient failure. Sent as Idempotency-Key.",
        },
        find: {
          type: "string",
          description: "Return only the lines of the response body matching this text (case-insensitive) plus surrounding context, instead of the whole body. Prefer this over reading the whole body when you know what you're looking for.",
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
        "User-Agent": BROWSER_USER_AGENT,
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
      if (args.idempotency_key && !Object.keys(headers).some(key =>
        ["idempotency-key", "x-idempotency-key"].includes(key.toLowerCase()),
      )) {
        headers["Idempotency-Key"] = String(args.idempotency_key);
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
        for (let attempt = 1; attempt <= 3 && RETRYABLE.includes(res.status) && isRetryableTool(tool, args); attempt++) {
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

        const fullBytes = body.length;
        const find = typeof args.find === "string" ? args.find.trim() : "";
        if (find) {
          const found = findInBody(body, find);
          const wrapped = wrapExternalContent(found.text, "http_request", {
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
            find,
            match_count: found.matchCount,
            content_type: contentType || undefined,
          };
          return res.ok ? ok(output, meta) : err(output, meta);
        }

        const MAX_CHARS = 100_000;
        // Spill-on-cap: the full body lands on disk and the note tells the model
        // how to keep reading past the cut (screened per chunk by `read`).
        const capped = capWithSpill(body, MAX_CHARS);
        const truncated = capped.truncated;
        body = capped.body;

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
  return tool;
}
