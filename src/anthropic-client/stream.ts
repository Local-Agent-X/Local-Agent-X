import { usesAnthropicSubscriptionAuth } from "../anthropic-models.js";
import { streamViaAPI } from "./stream-api.js";
import { streamViaCliWithTools } from "./stream-cli.js";
import type { StreamEvent, StreamOptions } from "./types.js";

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
  if (options.token === "cli" || usesAnthropicSubscriptionAuth(options.token)) {
    yield* streamViaCliWithTools(options);
  } else {
    yield* streamViaAPI(options);
  }
}
