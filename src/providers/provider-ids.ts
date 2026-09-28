export const PROVIDER_IDS = [
  "codex",
  "xai",
  "openai",
  "anthropic",
  "anthropic-api",
  "local",
  "ollama-cloud",
  "gemini",
  "cerebras",
  "custom",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

/**
 * The two Anthropic picker entries share one runtime (the native Messages
 * API adapter) and differ only in the credential: "anthropic" is the Claude
 * subscription sign-in, "anthropic-api" a pay-as-you-go key saved in LAX's
 * secrets store. Every routing decision keyed on the runtime uses this; every
 * decision keyed on the credential (billing, window sizing, which token the
 * transport carries) must NOT — the two ids are distinct there on purpose.
 */
export function isAnthropicProvider(p: string): p is "anthropic" | "anthropic-api" {
  return p === "anthropic" || p === "anthropic-api";
}

// Providers whose models support function-calling but chronically UNDER-call
// tools — they answer from their own knowledge instead of reaching for a tool
// the task needs (Grok/SuperGrok is trained chat-first). For these we force
// known-recall tools the model would otherwise skip. Distinct from
// hasNoToolSupport() in providers/types.ts, which means the endpoint can't do
// tools at all.
const TOOL_SHY_PROVIDERS = new Set<ProviderId>(["xai"]);

export function providerUndercallsTools(p: string): boolean {
  return (TOOL_SHY_PROVIDERS as Set<string>).has(p);
}
