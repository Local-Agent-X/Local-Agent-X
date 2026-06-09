export const PROVIDER_IDS = [
  "codex",
  "xai",
  "openai",
  "anthropic",
  "local",
  "ollama-cloud",
  "gemini",
  "cerebras",
  "custom",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

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
