const MODEL_CONTEXTS: Record<string, number> = {
  "gpt-5.3-codex-spark": 128_000,
  "gpt-5.4": 272_000,        // Native 1.05M, default working 272k
  "gpt-5.4-mini": 272_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.5-pro": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "grok-3-mini": 131_072,
  "grok-3": 131_072,
  // Anthropic Claude 4.x family — 200k base window
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-7": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 1_000_000, // 4.7 ships with 1M context natively
  "claude-opus-4-8": 1_000_000, // 4.8 ships with 1M context natively
  "claude-haiku-4-5": 200_000,
  // Anthropic Opus 4.6 with 1M context beta
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-8[1m]": 1_000_000,
  // Gemini 2.x family
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro-preview-05-06": 1_000_000,
  "gemini-2.5-flash-preview-05-20": 1_000_000,
};

// Ollama models typically have smaller context; use conservative default
export const DEFAULT_CONTEXT = 128_000;

export function lookupContextWindow(model: string): number {
  if (MODEL_CONTEXTS[model]) return MODEL_CONTEXTS[model];
  const lower = model.toLowerCase();
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gemini")) return 1_000_000;
  if (lower.includes("gpt-5.5")) return 1_000_000;
  if (lower.includes("gpt-5.4")) return 272_000;
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3")) return 128_000;
  if (lower.includes("grok")) return 131_072;
  return DEFAULT_CONTEXT;
}

/**
 * Codex models (OpenAI gpt-5.x family) have a NOMINAL context window of up
 * to 1M tokens, but their PRACTICAL agentic performance degrades well before
 * that. We saw a 334k-token Codex turn end with "I'm missing the actual task
 * context" despite making real edits — the original task was buried under
 * tool results. Compact much earlier for Codex regardless of the nominal
 * window so the original user message stays anchored near the response
 * position. Anthropic models hold focus better and don't need this.
 */
export function isCodexModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("o1") || lower.startsWith("o3");
}
