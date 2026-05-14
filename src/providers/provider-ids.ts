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
