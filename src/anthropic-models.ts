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
  // Opus 5 — Claude 5 Opus tier (1M context, native default). Adaptive-only like
  // the rest of the Claude 5 family, with one extra wrinkle: thinking is ON when
  // the request omits it (4.8/4.7 ran thinking-off), and disabling it is only
  // legal at effort `high` or below. Same $5/$25 as 4.8.
  if (matchesModelRef(lower, ["claude-opus-5", "claude-opus.5"]) || lower === "claude-opus-5[1m]") return "claude-opus-5";
  // 4.8 family (May 2026 — Opus 4.8 ships with 1M context)
  if (matchesModelRef(lower, ["claude-opus-4-8", "claude-opus-4.8"]) || lower === "claude-opus-4-8[1m]") return "claude-opus-4-8";
  // 4.7 family (April 2026 — Opus 4.7 ships with 1M context)
  if (matchesModelRef(lower, ["claude-opus-4-7", "claude-opus-4.7"]) || lower === "claude-opus-4-7[1m]") return "claude-opus-4-7";
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
 * Fable 5, Mythos 5, Opus 5, Opus 4.6/4.7/4.8, Sonnet 5, Sonnet 4.6. For these
 * the request must send `thinking: {type: "adaptive"}` and must NOT send
 * `temperature`, `top_p`, `top_k`, or `budget_tokens` — Fable 5, Opus 5, Opus
 * 4.7/4.8, and Sonnet 5 return a 400 on any of them (4.6/Sonnet 4.6 accept them
 * but adaptive is the supported path). Older models (Opus 4.5, Sonnet 4.5, Opus
 * 4.0, Sonnet 4) keep the legacy `{type: "enabled", budget_tokens}` +
 * `temperature: 1` shape.
 *
 * `opus-5` is a separate alternation branch from `opus-4-[678]` on purpose:
 * claude-opus-4-5 must NOT match (it is a legacy-shape model), and it doesn't —
 * the pattern is anchored, so 4.5 falls through to the legacy branch.
 */
export function anthropicUsesAdaptiveThinking(model: string): boolean {
  const m = normalizeAnthropicModel(model).toLowerCase();
  return /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(m);
}

export type AnthropicThinkingOffMode = "omit" | "disabled-block" | "always-on";

/**
 * How a request turns thinking OFF for a model — the wire shape behind
 * `disableThinking`. Omission is NOT a universal off-switch: what leaving the
 * `thinking` param out means varies per model family, which is exactly the
 * trap that made the flag a silent no-op on part of the adaptive set.
 *
 * - "omit": omitting `thinking` runs WITHOUT thinking. Legacy
 *   enabled+budget models, plus Opus 4.6 / Sonnet 4.6 (adaptive must be
 *   requested explicitly there, and `{type: "disabled"}` is not a documented
 *   shape for that generation).
 * - "disabled-block": send `thinking: {type: "disabled"}`. Opus 5 and
 *   Sonnet 5 default to adaptive when the param is omitted, so only the
 *   explicit block turns thinking off; Opus 4.7/4.8 document the same block,
 *   and sending it pins the intent instead of leaning on their omission
 *   default. Opus 5 wrinkle: `disabled` is only legal at effort `high` or
 *   below — effort now DOES ride this path (voice runs adaptive at low
 *   effort), so resolveAnthropicEffort below drops an `xhigh`/`max` that would
 *   be paired with a disabled block rather than letting the turn 400.
 * - "always-on": thinking cannot be turned off. Fable 5 / Mythos 5 reject
 *   `{type: "disabled"}` with a 400 AND run adaptive when the param is
 *   omitted — the request layer omits the param and warns so the caller's
 *   latency budget isn't silently spent on reasoning tokens.
 */
export function anthropicThinkingOffMode(model: string): AnthropicThinkingOffMode {
  const m = normalizeAnthropicModel(model).toLowerCase();
  if (/^claude-(fable-5|mythos-5)/.test(m)) return "always-on";
  if (/^claude-(opus-5|sonnet-5|opus-4-[78])/.test(m)) return "disabled-block";
  return "omit";
}

/** Levels the Messages API accepts on `output_config.effort`. */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_FULL: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_NO_XHIGH: readonly AnthropicEffort[] = ["low", "medium", "high", "max"];
const EFFORT_LEGACY: readonly AnthropicEffort[] = ["low", "medium", "high"];
const EFFORT_NONE: readonly AnthropicEffort[] = [];

/**
 * Which `output_config.effort` levels a model accepts — the third axis of the
 * one capability map, alongside anthropicUsesAdaptiveThinking and
 * anthropicThinkingOffMode. Effort rides INSIDE `output_config`, never
 * top-level, and omitting it is equivalent to the API default `high`.
 *
 * - Fable 5 / Mythos 5 / Opus 5 / Opus 4.7 / 4.8 / Sonnet 5: all five levels.
 * - Opus 4.6 / Sonnet 4.6: no `xhigh` — that level arrived with Opus 4.7.
 * - Opus 4.5: `low`/`medium`/`high` only.
 * - Everything else (Sonnet 4.5, Haiku 4.5, pre-4.5, unknown ids): the
 *   parameter ERRORS there, so nothing is sendable and the field is omitted.
 *
 * Same anchored-alternation care as the two maps above: `opus-5` is its own
 * branch so `claude-opus-4-5` cannot match it, and `opus-4-[78]` cannot match
 * 4.5 either — 4.5 falls through to its own smaller set.
 */
export function anthropicEffortLevels(model: string): readonly AnthropicEffort[] {
  const m = normalizeAnthropicModel(model).toLowerCase();
  if (/^claude-(fable-5|mythos-5|opus-5|opus-4-[78]|sonnet-5)/.test(m)) return EFFORT_FULL;
  if (/^claude-(opus-4-6|sonnet-4-6)/.test(m)) return EFFORT_NO_XHIGH;
  if (/^claude-opus-4-5/.test(m)) return EFFORT_LEGACY;
  return EFFORT_NONE;
}

/**
 * The effort value a request may actually put on the wire, or `undefined` to
 * omit the field. Two API constraints, both resolved here so no caller has to
 * carry a second model table:
 *
 * 1. Support — a level the model doesn't accept (any level on Sonnet 4.5 /
 *    Haiku 4.5, `xhigh` on the 4.6 generation) is OMITTED rather than sent and
 *    400'd. Omission means the API default `high`.
 * 2. Thinking interaction — Opus 5 / Sonnet 5 / Opus 4.7/4.8 accept
 *    `thinking: {type: "disabled"}` only at effort `high` or below; pairing it
 *    with `xhigh`/`max` returns a 400. A caller asking for both gets the
 *    effort dropped (default `high` keeps the pair legal) instead of a dead
 *    turn. This discharges the "revisit if effort ever rides this path" note
 *    left on anthropicThinkingOffMode when disableThinking was made honest.
 *
 * Dropping is never silent: the request layer warns once per model+level.
 */
export function resolveAnthropicEffort(
  model: string,
  effort: AnthropicEffort | undefined,
  thinkingDisabled = false,
): AnthropicEffort | undefined {
  if (!effort) return undefined;
  if (!anthropicEffortLevels(model).includes(effort)) return undefined;
  if (thinkingDisabled && anthropicThinkingOffMode(model) === "disabled-block" && (effort === "xhigh" || effort === "max")) {
    return undefined;
  }
  return effort;
}

/**
 * Maximum OUTPUT tokens for a Claude model — the single source of truth for the
 * `max_tokens` request ceiling when a caller doesn't pass an explicit one. The
 * Messages API REQUIRES max_tokens on every request and has no "unlimited"
 * value, so a number is always sent; deriving it from the model's real ceiling
 * (rather than one flat legacy constant) is what stops a large single-turn
 * generation — e.g. an app build that emits a whole HTML file in one write —
 * from silently truncating at `stop_reason: max_tokens` and shipping a partial.
 * The sole consumer (streamViaAPI) always streams, so a large ceiling is safe
 * from the non-streaming HTTP-timeout concern that gates big max_tokens.
 *
 * Every current Claude model streams up to 128K output except Haiku 4.5 (64K).
 * Unknown / pre-4.5 ids fall back to the historical 8192 floor — conservative:
 * never below the old default, and never above a small legacy model's real cap.
 * Keyed off the normalized id so aliases (`claude-opus-5[1m]`, `anthropic/…`)
 * resolve correctly. New models: add the id to the 128K/64K list here — this is
 * the one place the ceiling is defined.
 */
export function anthropicMaxOutputTokens(model: string): number {
  const id = normalizeAnthropicModel(model);
  if (matchesModelRef(id, ["claude-haiku-4-5"])) return 64_000;
  if (
    matchesModelRef(id, [
      "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5",
      "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
      "claude-sonnet-4-6", "claude-sonnet-4-5",
    ])
  ) {
    return 128_000;
  }
  return 8_192;
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
