import type { CredentialSource } from "../auth/auth-provider.js";
import type { AnthropicTransport } from "./effective-window.js";

/**
 * Which Anthropic billing lane a request runs over, for context-window sizing
 * (effectiveContextWindow). This resolves the BILLING LANE, not the wire
 * transport: subscription credentials → "cli" (the measured subscription
 * window); a pay-as-you-go key → "api" (the nominal window).
 *
 * The lane is a property of the credential the request carries, so it is
 * decided from the credential SOURCE the op was admitted with:
 *   - "secrets-store" is the only way an API key enters LAX (the picker's
 *     "Anthropic API (direct key)" entry, provider `anthropic-api`, resolves
 *     the store and nothing else) → "api".
 *   - "oauth" is the subscription → "cli".
 *   - anything else, or unknown → "cli": the smaller window is the safe
 *     assumption, over-compacting is recoverable and under-compacting kills
 *     the op on a raw "prompt is too long".
 *
 * The result is model-independent: it only changes sizing for Anthropic models
 * (see effectiveContextWindow), so resolving it on a Codex/Gemini turn is
 * harmless.
 */
export function resolveAnthropicTransport(authSource?: CredentialSource): AnthropicTransport {
  return authSource === "secrets-store" ? "api" : "cli";
}

/** The credential source an op was admitted with: the sealed delegated runtime
 *  for agent ops, the routing pack for chat ops. Structural so the
 *  context-manager stays free of the ops types. */
export interface OpCredentialSource {
  runtimeDescriptor?: { authSource?: CredentialSource } | { kind: string };
  contextPack?: { routing?: { authSource?: CredentialSource } };
}

export function opAnthropicTransport(op: OpCredentialSource): AnthropicTransport {
  const descriptor = op.runtimeDescriptor as { authSource?: CredentialSource } | undefined;
  return resolveAnthropicTransport(descriptor?.authSource ?? op.contextPack?.routing?.authSource);
}
