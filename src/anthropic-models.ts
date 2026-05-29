export type AnthropicAuthMode = "api" | "subscription";

function stripAnthropicPrefix(model: string): string {
  return model.trim().replace(/^anthropic\//i, "");
}

function matchesModelRef(model: string, refs: string[]): boolean {
  return refs.some((ref) => model === ref || model.startsWith(`${ref}-`));
}

/**
 * Normalize Anthropic model ids so older saved settings and mixed alias styles
 * still resolve to the current runtime ids Anthropic accepts.
 */
export function normalizeAnthropicModel(model: string, mode: AnthropicAuthMode = "api"): string {
  const trimmed = stripAnthropicPrefix(model);
  if (!trimmed) return "claude-sonnet-4-6";

  const lower = trimmed.toLowerCase();

  // 4.8 family (May 2026 — Opus 4.8 ships with 1M context)
  if (matchesModelRef(lower, ["claude-opus-4-8", "claude-opus-4.8"]) || lower === "claude-opus-4-8[1m]") return "claude-opus-4-8";
  // 4.7 family (April 2026 — Opus 4.7 ships with 1M context)
  if (matchesModelRef(lower, ["claude-opus-4-7", "claude-opus-4.7"]) || lower === "claude-opus-4-7[1m]") return "claude-opus-4-7";
  if (matchesModelRef(lower, ["claude-sonnet-4-7", "claude-sonnet-4.7"])) return "claude-sonnet-4-7";
  if (matchesModelRef(lower, ["claude-sonnet-4-6", "claude-sonnet-4.6"])) return "claude-sonnet-4-6";
  if (matchesModelRef(lower, ["claude-opus-4-6", "claude-opus-4.6"])) return "claude-opus-4-6";
  if (matchesModelRef(lower, ["claude-sonnet-4-5", "claude-sonnet-4.5"]) || lower === "claude-sonnet-4-5-20250929") return "claude-sonnet-4-5";
  if (matchesModelRef(lower, ["claude-opus-4-5", "claude-opus-4.5"]) || lower === "claude-opus-4-5-20251101") return "claude-opus-4-5";
  if (matchesModelRef(lower, ["claude-haiku-4-5", "claude-haiku-4.5"]) || lower === "claude-haiku-4-5-20251001") return "claude-haiku-4-5";

  // Subscription auth in third-party tools is happiest with the current
  // Claude 4.6/4.5 aliases rather than older snapshot ids.
  if (mode === "subscription") {
    if (lower === "claude-sonnet-4-20250514" || lower === "claude-sonnet-4-0" || lower === "claude-sonnet-4.0" || lower === "claude-sonnet-4") {
      return "claude-sonnet-4-6";
    }
    if (lower === "claude-opus-4-20250514" || lower === "claude-opus-4-0" || lower === "claude-opus-4.0" || lower === "claude-opus-4") {
      return "claude-opus-4-6";
    }
    if (lower === "claude-haiku-4-20250514" || lower === "claude-haiku-4") {
      return "claude-haiku-4-5";
    }
  }

  return trimmed;
}

export function usesAnthropicSubscriptionAuth(token: string): boolean {
  return token === "cli" || token.startsWith("oauth:") || token.includes("sk-ant-oat");
}

export function buildAnthropicRateLimitHint(status: number, token: string): string {
  if (status !== 429 || !usesAnthropicSubscriptionAuth(token)) return "";
  return " Note: Claude subscription auth used inside external tools now requires Extra Usage (per Anthropic guidance, April 2026), and Anthropic cooldowns can also be model-scoped.";
}

export function unwrapAnthropicSubscriptionToken(token: string): string {
  return token.startsWith("oauth:") ? token.slice("oauth:".length) : token;
}
