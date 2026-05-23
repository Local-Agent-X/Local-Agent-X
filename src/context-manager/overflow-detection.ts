// Providers return very different error messages for "too many tokens":
//   OpenAI:    "context_length_exceeded" / "maximum context length"
//   Anthropic: "prompt is too long" / "input is too long"
//   Grok/xAI:  "maximum context length" / "too many tokens"
//   Gemini:    "exceeds the maximum" / "400 ... too long"
// This check is signature-based so callers can force-compact + retry instead
// of returning a hard error.

export function isContextOverflowError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("context window") ||
    msg.includes("prompt is too long") ||
    msg.includes("input is too long") ||
    msg.includes("too many tokens") ||
    msg.includes("exceeds the maximum") ||
    msg.includes("token limit") ||
    msg.includes("max_tokens_exceeded") ||
    (msg.includes("400") && msg.includes("too long"))
  );
}
