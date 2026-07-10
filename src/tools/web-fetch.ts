import { fetch as undiciFetch } from "undici";
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import { findInBody } from "./paginate-body.js";
import { ok, err } from "./result-helpers.js";
import { capWithSpill } from "./result-spill.js";
import { extractFromHtml } from "./html-extract.js";
import {
  EgressRedirectBlocked,
  assertRedirectEgressAllowed,
  assertLiteralIpEgressAllowed,
  selfCallAuthHeader,
  createPinningDispatcher,
  BROWSER_USER_AGENT,
  BROWSER_ACCEPT_LANGUAGE,
} from "./web-egress.js";

// Full top-level-navigation fingerprint. WAFs (Cloudflare, Akamai, PerimeterX
// on TCGplayer/eBay) score header completeness: a request that carries the
// Sec-Fetch-* metadata and Client Hints a real Chrome sends on a typed-URL
// navigation clears far more of them than a bare UA. The sec-ch-ua version
// MUST track the Chrome major in BROWSER_USER_AGENT (125) or the cross-check
// fails. Accept-Encoding is intentionally omitted — undici only auto-decodes
// the response when it owns that header, so setting it ourselves yields a
// gzip/br body that .text() returns as garbage.
const FETCH_HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": BROWSER_ACCEPT_LANGUAGE,
  "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
} as const;

export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  effect: { class: "read-only" },
  description: "Fetch a URL and return its text content. Useful for reading web pages and APIs.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      find: {
        type: "string",
        description: "Return only the lines of the page matching this text (case-insensitive) plus surrounding context, instead of the whole page. Prefer this over reading the whole page when you know what you're looking for.",
      },
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
          headers: { ...FETCH_HEADERS, ...selfAuth },
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
            headers: { ...FETCH_HEADERS, ...selfAuth },
            signal: AbortSignal.timeout(30_000),
            redirect: "manual",
            dispatcher,
          });
          redirects++;
        }
        return r;
      };

      const res = await doFetch();

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

      // Return readable content, not a raw-HTML haystack. web_fetch gets no JS
      // execution, so a JS-heavy page dumps 50K chars of obfuscated markup the
      // model can't parse — every model then flails, and the give-up-prone ones
      // quit (the Reuters-headline failure). Extract title + meta + JSON-LD +
      // visible text on HTML; pass JSON/XML/RSS/sitemap/plain through RAW (the
      // model wants those structured). Sniff the body when content-type is
      // missing so a mislabeled text/plain HTML page still gets cleaned up.
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const isHtml =
        /text\/html|application\/xhtml/.test(contentType) ||
        (!contentType && /^﻿?\s*<(?:!doctype html|html)\b/i.test(body));
      if (isHtml) {
        const extracted = extractFromHtml(body);
        body = extracted.looksEmpty
          ? "[This page is JS-rendered — its content is loaded client-side and is NOT in the static HTML, " +
            "so there is nothing to extract. Reach the same goal another way: try the site's structured " +
            "endpoints (sitemap.xml / news-sitemap.xml / an RSS or JSON feed) or the JSON API the page calls; " +
            "if it needs a logged-in session, use the browser tool." +
            (extracted.content ? `\n\nThe little that was extractable:\n${extracted.content}` : "")
          : extracted.content;
      }

      const fullBytes = body.length;
      const find = typeof args.find === "string" ? args.find.trim() : "";
      if (find) {
        const found = findInBody(body, find);
        return ok(wrapExternalContent(found.text, "web_fetch", { url, status: String(res.status) }), {
          url: currentUrl,
          status: res.status,
          duration_ms: durationMs,
          bytes: fullBytes,
          find,
          match_count: found.matchCount,
        });
      }

      const MAX_CHARS = 50_000;
      // Spill-on-cap: the full body lands on disk and the note tells the model
      // how to keep reading past the cut (screened per chunk by `read`).
      const capped = capWithSpill(body, MAX_CHARS);
      const truncated = capped.truncated;
      body = capped.body;

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
