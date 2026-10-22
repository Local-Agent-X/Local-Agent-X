import type { ToolDefinition, ToolResult } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import { findInBody } from "./paginate-body.js";
import type { SecretsStore } from "../secrets.js";
import type { ServerEvent } from "../types.js";
import { gateSecretDestinations, referencedSecretNames } from "../secret-destination-gate.js";
import { ok, err, blocked } from "./result-helpers.js";
import { capWithSpill } from "./result-spill.js";
import { checkOutboundRequest } from "./http-egress-guard.js";
import { vouchedFor } from "../browser/site-provenance.js";
import { formatMissingPageLeads, gatherMissingPageLeads, isMissingPageStatus } from "./missing-page-leads.js";
import { withholdSecretValues, secretsMaskedNote, isSecretEndpointUrl } from "../data-lineage/index.js";
import { EgressRedirectBlocked, canonicalFetch } from "./web-egress.js";
import { EgressPayloadBlocked } from "../net/egress-send.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { paidMediaApisAllowed, paidMediaEndpointKind, paidMediaOffMessage } from "./image-tools/paid-media.js";
import { SecretRedirectStopped, startingHeaders } from "./http-request-transport.js";
import { saveResponseBody } from "./http-download.js";
import { resolveAgentPath } from "../workspace/paths.js";

export { isCredentialHeader } from "./web-egress.js";

export function createHttpRequestTool(secrets?: SecretsStore): ToolDefinition {
  const tool: ToolDefinition = {
    name: "http_request",
    describeCall: (args) => `API call: ${args.method || "GET"} ${String(args.url || "").slice(0, 100)}`,
    compactDescription: "Make an HTTP request to any API (any method, headers, body). Inject stored secrets in header values with {{SECRET_NAME}}, e.g. \"Authorization\": \"Bearer {{GITHUB_TOKEN}}\"; call request_secret first if it isn't stored.",
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
      const operationKey = typeof rawKey === "string" && rawKey.trim().length > 0 ? rawKey : "";
      return operationKey ? { class: "keyed-mutation", operationKey } : { class: "non-idempotent" };
    },
    description:
      "Make a full HTTP request to any API. Supports all methods, custom headers, authentication, and request bodies. " +
      "Use {{SECRET_NAME}} syntax in header values or the body to inject stored secrets server-side (e.g. \"Authorization\": \"Bearer {{GITHUB_TOKEN}}\"); you never see the value. " +
      "Use request_secret first if the needed secret isn't stored yet. " +
      "A secret is bound to the hosts it may reach: its first use at a new origin asks the user once in the chat (a yes is kept for that secret and origin), " +
      "unless this session captured the secret, an op_submit_async run pre-blessed it, or the origin is the secret's own recorded site. A declined request returns status declined. " +
      "A redirect to another origin is not followed while a secret in the request is unapproved there; re-issue against that host to be asked. " +
      "Use this to integrate with external services (GitHub, Slack, Jira, Linear, Discord, REST/GraphQL APIs, etc.). " +
      "You can also replay an API endpoint that the in-app browser surfaced via read_network (the browser's 'API/data endpoints observed' list) to fetch a page's data directly — those URLs are path-only, so add back any needed query params and verify the response.",
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
        save_to: {
          type: "string",
          description: "Download: write the response body to this file path instead of returning it (any size up to 2 GB, binary-safe: a tarball, an installer, a wheel, an image, a dataset). The result reports the path and size. An error response is returned as usual and nothing is saved.",
        },
        find: {
          type: "string",
          description: "Return only the lines of the response body matching this text (case-insensitive) plus surrounding context, instead of the whole body. Prefer this over reading the whole body when you know what you're looking for.",
        },
      },
      required: ["url"],
    },
    async execute(args, signal?: AbortSignal) {
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

      const guard = checkOutboundRequest(
        { url, method, body: args.body, headers: args.headers },
        vouchedFor("http_request", args, sessionIdOf(args) ?? ""),
      );
      if (guard) return err(guard.message, guard.meta);

      const { headers, modelHeaders: rawHeaders, selfAuth, droppedNote, droppedMeta } = await startingHeaders(url, args.headers);
      let bodyStr = args.body ? String(args.body) : undefined;
      // Every secret bound into this request must be allowed at its destination
      // (ADR 0005) before a single placeholder is resolved.
      const sessionId = sessionIdOf(args) ?? "";
      const boundNames = secrets ? referencedSecretNames([...rawHeaders.map(([, v]) => v), bodyStr ?? ""].join("\n")) : [];
      // A vault secret is an API key, and on a provider's image or video route
      // it is billed per use: the same switch as generate_image's governs it.
      const paidMedia = boundNames.length > 0 ? paidMediaEndpointKind(url) : null;
      if (paidMedia && !paidMediaApisAllowed()) return err(paidMediaOffMessage(paidMedia));
      if (secrets && boundNames.length > 0) {
        const missing = boundNames.filter((name) => !secrets.has(name));
        if (missing.length > 0) {
          return err(`Missing secrets: ${missing.join(", ")}. Use request_secret to ask the user for these credentials first.`);
        }
        const gate = await gateSecretDestinations(
          boundNames.map((name) => ({ name, destination: url, purpose: `Send ${name} to ${new URL(url).host} (${method} ${url})` })),
          { store: secrets, sessionId, toolName: "http_request", call: args },
        );
        if (!gate.allowed) return gate.result;
      }
      /** The bound secrets the ladder does not allow at a redirect target. */
      const unapprovedAt = (location: string): string[] =>
        boundNames.filter((name) => secrets!.destinationDecision(name, location, { sessionId }) === "ask");
      for (const [key, value] of rawHeaders) headers[key] = secrets ? secrets.resolve(value) : value;
      if (bodyStr && secrets) bodyStr = secrets.resolve(bodyStr);
      if (args.idempotency_key && !Object.keys(headers).some(key =>
        ["idempotency-key", "x-idempotency-key"].includes(key.toLowerCase()),
      )) {
        headers["Idempotency-Key"] = String(args.idempotency_key);
      }

      const sendsBody = Boolean(bodyStr) && method !== "GET" && method !== "HEAD";
      if (sendsBody && !headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }

      // The secrets this call was cleared to send: the send-time judge does not
      // count them as a stored secret leaving.
      const approvedSecretValues = secrets ? boundNames.map((name) => secrets.get(name) ?? "") : [];

      try {
        // The one hardened transport (web-egress.ts canonicalFetch): the policy
        // and the literal-IP guard on every hop, credential headers stripped
        // across origins, 303 as a GET. The turn's cancellation signal and the
        // self-bound ceiling both apply. A redirect to an origin where a bound
        // secret is not approved is never sent.
        const res = await canonicalFetch(url, {
          method,
          headers,
          ...(sendsBody ? { body: bodyStr } : {}),
          timeoutMs: timeout,
          ...(signal ? { signal } : {}),
          beforeCrossOriginRedirect: (location) => {
            const unapproved = unapprovedAt(location);
            if (unapproved.length > 0) throw new SecretRedirectStopped(location, unapproved);
          },
          approvedSecretValues,
        });
        const currentUrl = res.url || url;

        const statusLine = `${res.status} ${res.statusText}`;

        const resHeaders: string[] = [];
        res.headers.forEach((value, key) => {
          resHeaders.push(`${key}: ${value}`);
        });

        const durationMs = Date.now() - startMs;
        if (method === "HEAD") {
          return ok(`HTTP ${statusLine}\n\n${resHeaders.join("\n")}${droppedNote}`, {
            url: currentUrl,
            method,
            status: res.status,
            duration_ms: durationMs,
            ...droppedMeta,
          });
        }

        const saveTo = typeof args.save_to === "string" ? args.save_to.trim() : "";
        if (saveTo && res.ok) {
          // Resolved as the pre-dispatch file-access gate resolved it (pathArgs).
          const path = resolveAgentPath(saveTo, sessionIdOf(args));
          const bytes = await saveResponseBody(res, path, signal);
          const type = res.headers.get("content-type");
          return ok(`HTTP ${statusLine}\n\nSaved ${bytes} bytes${type ? ` (${type})` : ""} to ${path}.${droppedNote}`, {
            url: currentUrl, method, status: res.status, duration_ms: durationMs, bytes, saved_to: path, ...droppedMeta,
          });
        }

        let body = await res.text();

        // Same evidence web_fetch gives for a moved page (missing-page-leads.ts).
        // GET only: a 404 from a mutation is an API answer, not a moved page.
        let leadsNote = "";
        if (method === "GET" && isMissingPageStatus(res.status) && !selfAuth) {
          const leads = formatMissingPageLeads(await gatherMissingPageLeads(currentUrl, body));
          if (leads) {
            leadsNote = "\n\nThis page is gone. Open the closest match below before trying anything else.\n" +
              wrapExternalContent(leads, "http_request", { url: currentUrl, status: statusLine });
          }
        }

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            // Keep raw body
          }
        }

        // Secret values are masked BEFORE `find` runs over the body, so the
        // filter can only ever select masked lines — the model cannot grep a
        // value out of a response it is not allowed to see. Every value the
        // masker hid is registered as a known secret at the same time.
        const secrets = withholdSecretValues(body, {
          endpoint: isSecretEndpointUrl(url) || isSecretEndpointUrl(currentUrl),
        });
        body = secrets.text;
        const maskedNote = secrets.masked > 0 ? `\n\n${secretsMaskedNote(secrets.masked, secrets.kinds)}` : "";
        const maskedMeta = secrets.masked > 0 ? { secrets_masked: secrets.masked } : {};

        const fullBytes = body.length;
        const find = typeof args.find === "string" ? args.find.trim() : "";
        if (find) {
          const found = findInBody(body, find);
          const wrapped = wrapExternalContent(found.text, "http_request", {
            url,
            method,
            status: statusLine,
          });
          const output = `HTTP ${statusLine}\n\n${wrapped}${leadsNote}${maskedNote}${droppedNote}`;
          const meta = {
            url: currentUrl,
            method,
            status: res.status,
            duration_ms: durationMs,
            bytes: fullBytes,
            find,
            match_count: found.matchCount,
            content_type: contentType || undefined,
            ...maskedMeta,
            ...droppedMeta,
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
        const output = `HTTP ${statusLine}\n\n${wrapped}${leadsNote}${maskedNote}${droppedNote}`;
        const meta = {
          url: currentUrl,
          method,
          status: res.status,
          duration_ms: durationMs,
          bytes: fullBytes,
          truncated: truncated || undefined,
          content_type: contentType || undefined,
          ...maskedMeta,
          ...droppedMeta,
        };
        return res.ok ? ok(output, meta) : err(output, meta);
      } catch (e) {
        return requestFailedResult(e, { url, method, startMs, droppedNote, droppedMeta });
      }
    },
  };
  return tool;
}

/** The result for a request the transport refused or that failed on the wire:
 *  a redirect a bound secret may not follow, bytes refused at send (a blocked
 *  card, with the declassify control when taint fired), a destination the
 *  policy refused, or a plain network failure. */
function requestFailedResult(
  e: unknown,
  c: { url: string; method: string; startMs: number; droppedNote: string; droppedMeta: Record<string, unknown> },
): ToolResult {
  const base = { url: c.url, method: c.method, duration_ms: Date.now() - c.startMs, ...c.droppedMeta };
  if (e instanceof SecretRedirectStopped) {
    return err(`${e.message}${c.droppedNote}`, {
      ...base,
      blocked_url: e.location,
      recovery: `Re-issue the request against ${e.location} if that host should have ${e.names.map((n) => `{{${n}}}`).join(", ")}; the user is asked once and a yes is kept.`,
    });
  }
  if (e instanceof EgressPayloadBlocked) {
    return blocked(`${e.message}${c.droppedNote}`, {
      ...base,
      layer: e.layer,
      recovery: e.clearable ? "Leave the sensitive content out of the request, or ask the user to click \"Declassify & retry\" on this card." : "Remove that content from the request and retry.",
      ...(e.clearable ? { clearable: e.clearable } : {}),
    });
  }
  if (e instanceof EgressRedirectBlocked) return err(`${e.message}${c.droppedNote}`, { ...base, blocked_url: e.blockedUrl });
  return err(`HTTP request failed: ${(e as Error).message}${c.droppedNote}`, base);
}
