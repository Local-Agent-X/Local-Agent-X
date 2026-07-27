import { usesAnthropicSubscriptionAuth, unwrapAnthropicSubscriptionToken } from "../anthropic-models.js";
import { streamViaAPI } from "./stream-api.js";
import { streamViaCliWithTools } from "./stream-cli.js";
import { isDirectOAuthToken, wrapDirectOAuthToken, resolveWrappedDirectToken } from "./oauth-direct.js";
import { isAnthropicCliTransportEnabled, CLI_TRANSPORT_HIDDEN_REASON } from "./cli-transport.js";
import { createLogger } from "../logger.js";
import type { StreamEvent, StreamOptions } from "./types.js";

const logger = createLogger("anthropic-client.stream");

/**
 * Convert a subscription-shaped credential into a token the direct-HTTP path
 * can use, now that the CLI subprocess is hidden (see cli-transport.ts).
 *
 *   - `oauth:<bearer>` / raw `sk-ant-oat…` → wrap the bearer as-is.
 *   - the `"cli"` sentinel carries no bearer, so re-resolve one from the auth
 *     store (LAX's own refreshable grant, then the CLI credential file).
 *
 * Returns null when nothing usable exists — the caller surfaces an auth error
 * rather than spawning a binary that may not be installed.
 */
async function toDirectToken(token: string): Promise<string | null> {
  if (isDirectOAuthToken(token)) return token;
  if (token === "cli") return resolveWrappedDirectToken();
  const bearer = unwrapAnthropicSubscriptionToken(token).trim();
  return bearer ? wrapDirectOAuthToken(bearer) : null;
}

/**
 * Stream a response from Anthropic.
 * - Tools needed + OAuth → CLI proxy with tool descriptions in prompt (Claude picks tools via JSON)
 * - Tools needed + API key → Direct HTTP with native tool calling
 * - No tools + OAuth → CLI proxy (simple chat)
 * - No tools + API key → Direct HTTP
 */
export async function* streamAnthropicResponse(options: StreamOptions): AsyncGenerator<StreamEvent> {
  // CLI transport is hidden. Any subscription-shaped credential that used to
  // spawn `claude` is promoted to the direct-HTTP OAuth path FIRST, so the
  // routing below only ever sees a token it can actually serve. This is the
  // single chokepoint every Anthropic caller passes through — chat, dream,
  // cron, workers, skill-review and the classifiers all land here.
  if (
    !isAnthropicCliTransportEnabled()
    && !isDirectOAuthToken(options.token)
    && usesAnthropicSubscriptionAuth(options.token)
  ) {
    const direct = await toDirectToken(options.token);
    if (!direct) {
      yield { type: "error", error: CLI_TRANSPORT_HIDDEN_REASON };
      return;
    }
    logger.info("[anthropic] subscription credential → direct-HTTP path (CLI transport hidden)");
    options = { ...options, token: direct };
  }

  // Anthropic banned third-party apps from using subscription auth via the
  // vanilla SDK shape (April 4, 2026) — those requests 429. The SAME token IS
  // accepted when the request wears Claude Code's identity, which is what the
  // `direct-oauth:` wrapper selects in streamViaAPI. Since the promotion above
  // wraps every subscription credential, that path now serves ALL of them, not
  // just chat: dream, cron, workers and classifiers included.
  // Real pay-as-you-go API keys (sk-ant-api03-*) don't match
  // usesAnthropicSubscriptionAuth and continue to use plain x-api-key HTTP.
  // The `else if` CLI branch below is reachable ONLY with the hidden transport
  // re-enabled (LAX_ANTHROPIC_CLI_TRANSPORT=1); see cli-transport.ts.
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
      // The CLI fallback is only available when the hidden transport is
      // explicitly re-enabled. With it hidden, a billing/rate rejection must
      // surface to the caller — silently spawning a binary that may not exist
      // is what hung the background lane for 10 hours on 2026-07-26.
      if (
        ev.type === "error" && !produced && isPlanFallbackWorthy(ev.error)
        && isAnthropicCliTransportEnabled()
      ) {
        logger.warn(`[anthropic] direct-HTTP rejected (${(ev.error ?? "").slice(0, 300)}) — falling back to CLI proxy (plan-billed)`);
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
