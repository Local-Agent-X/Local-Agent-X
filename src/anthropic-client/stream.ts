import { usesAnthropicSubscriptionAuth } from "../anthropic-models.js";
import { streamViaAPI } from "./stream-api.js";
import { streamViaCliWithTools } from "./stream-cli.js";
import { isDirectOAuthToken } from "./oauth-direct.js";
import { createLogger } from "../logger.js";
import type { StreamEvent, StreamOptions } from "./types.js";

const logger = createLogger("anthropic-client.stream");

/**
 * Stream a response from Anthropic.
 * - Tools needed + OAuth → CLI proxy with tool descriptions in prompt (Claude picks tools via JSON)
 * - Tools needed + API key → Direct HTTP with native tool calling
 * - No tools + OAuth → CLI proxy (simple chat)
 * - No tools + API key → Direct HTTP
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  // Anthropic banned third-party apps from using subscription auth via direct SDK
  // (April 4, 2026). Under Max subscription, direct-SDK gets 429 on every request.
  // ALL subscription-style auth (cli sentinel, oauth: prefix, sk-ant-oat tokens,
  // claude setup-tokens) must go through the official CLI proxy — that's the only
  // path Anthropic still allows for subscription credentials.
  // Real pay-as-you-go API keys (sk-ant-api03-*) don't match usesAnthropicSubscriptionAuth
  // and continue to use direct HTTP via streamViaAPI — those are fine.
  // Chat opts into the direct-HTTP OAuth path (token wrapped `direct-oauth:`)
  // to stream real thinking text. It's a subscription token, but it goes to
  // streamViaAPI — which recognizes the wrapper and dons Claude Code's identity
  // rather than using x-api-key. Builds/sub-agents never wrap, so they stay CLI.
  if (isDirectOAuthToken(options.token)) {
    // Direct-HTTP OAuth path (real thinking). If Anthropic rejects the request
    // for a BILLING/RATE reason before any output — most importantly the 400
    // "You're out of extra usage" that fires when a request gets metered to the
    // extra-usage lane and that balance is exhausted — fall back to the CLI
    // proxy, which bills to the subscription PLAN and always works. Only fall
    // back on a pre-output error; once tokens have streamed we must not restart
    // (the user would see a duplicated answer). Non-billing errors (e.g. a real
    // abort) surface as-is.
    let produced = false;
    for await (const ev of streamViaAPI(options)) {
      if (ev.type === "error" && !produced && isPlanFallbackWorthy(ev.error)) {
        logger.warn(`[anthropic] direct-HTTP rejected (${(ev.error ?? "").slice(0, 80)}) — falling back to CLI proxy (plan-billed)`);
        yield* streamViaCliWithTools(options); // ignores the token; spawns `claude`
        return;
      }
      if (ev.type === "text" || ev.type === "thinking" || ev.type === "tool_call") produced = true;
      yield ev;
    }
  } else if (options.token === "cli" || usesAnthropicSubscriptionAuth(options.token)) {
    yield* streamViaCliWithTools(options);
  } else {
    yield* streamViaAPI(options);
  }
}

/**
 * True for direct-path errors that the CLI proxy can recover — a request
 * metered to the exhausted extra-usage lane, a rate-limit, or an auth/routing
 * rejection. These all succeed on the CLI (plan-billed). A genuine abort or a
 * malformed-request error is NOT retried (the CLI would fail the same way).
 */
export function isPlanFallbackWorthy(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  return (
    e.includes("extra usage") ||   // 400 "You're out of extra usage"
    e.includes("out of usage") ||
    e.includes("429") ||           // rate limit
    e.includes("rate limit") ||
    e.includes("overloaded") ||    // 529
    e.includes("401") ||           // token expired/invalid → CLI has its own auth
    e.includes("403")              // routing/tier rejection
  );
}
