import type { AnthropicTransport } from "./effective-window.js";

/**
 * Which Anthropic billing lane the next request uses, for context-window
 * sizing (effectiveContextWindow). This resolves the BILLING LANE, not the wire
 * transport: subscription credentials → "cli" (the smaller effective window);
 * a pay-as-you-go key → "api" (the nominal window).
 *
 * The "anthropic" provider is the picker's "Anthropic Claude (subscription
 * auth)" and resolves subscription credentials only (auth/anthropic.ts
 * getAnthropicApiKey) — an ANTHROPIC_API_KEY is never used for it — so this is
 * always "cli". A picker entry for a pay-as-you-go Anthropic key would be the
 * one caller of the "api" lane, and would pass its own lane here.
 *
 * The result is model-independent: it only changes sizing for Anthropic models
 * (see effectiveContextWindow), so resolving it on a Codex/Gemini turn is
 * harmless.
 */
export function resolveAnthropicTransport(): AnthropicTransport {
  return "cli";
}
