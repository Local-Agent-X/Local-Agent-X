import { fetch as undiciFetch } from "undici";
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import { ok, err } from "./result-helpers.js";
import {
  EgressRedirectBlocked,
  assertRedirectEgressAllowed,
  assertLiteralIpEgressAllowed,
  selfCallAuthHeader,
  createPinningDispatcher,
} from "./web-egress.js";

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
