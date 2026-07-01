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

  // Fable 5 — most capable GA model (1M context). Always-on thinking; the
  // request layer must not send budget_tokens/temperature on this id.
  if (matchesModelRef(lower, ["claude-fable-5", "claude-fable.5"]) || lower === "claude-fable-5[1m]") return "claude-fable-5";
  // Sonnet 5 — Claude 5 balanced tier (1M context). Same adaptive-only request
  // shape as Fable 5: the request layer must not send budget_tokens/temperature.
  if (matchesModelRef(lower, ["claude-sonnet-5", "claude-sonnet.5"]) || lower === "claude-sonnet-5[1m]") return "claude-sonnet-5";
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

/**
 * True for model families that use ADAPTIVE thinking on the Messages API:
 * Fable 5, Mythos 5, Opus 4.6/4.7/4.8, Sonnet 5, Sonnet 4.6. For these the
 * request must send `thinking: {type: "adaptive"}` and must NOT send
 * `temperature`, `top_p`, `top_k`, or `budget_tokens` — Fable 5, Opus 4.7/4.8,
 * and Sonnet 5 return a 400 on any of them (4.6/Sonnet 4.6 accept them but
 * adaptive is the supported path). Older models (Opus 4.5, Sonnet 4.5, Opus
 * 4.0, Sonnet 4) keep the legacy `{type: "enabled", budget_tokens}` +
 * `temperature: 1` shape.
 */
export function anthropicUsesAdaptiveThinking(model: string): boolean {
  const m = normalizeAnthropicModel(model).toLowerCase();
  return /^claude-(fable-5|mythos-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(m);
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
