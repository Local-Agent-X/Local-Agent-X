/**
 * Model price table — per 1M tokens (USD). The data half of cost-tracker.ts,
 * kept on its own so build tooling can read (and rewrite) rows without touching
 * billing logic.
 *
 * The app never fetches prices at runtime: the spend cap bills from this table,
 * so a third-party price file must not silently change what a user's cap charges
 * — rates change only through a reviewed commit to this file.
 */

/** `cacheRead` overrides CACHE_READ_MULTIPLIER for a model that repriced reads. */
export interface ModelPricing { input: number; output: number; cacheRead?: number }

// ── Cache pricing ──
// Anthropic prices cached tokens as multipliers on the model's INPUT rate: a
// cache read is ~0.1x, a cache write 1.25x at the default 5-min TTL (2x at 1h).
// Multipliers, not two more columns per row, because the ratio holds for most
// of the lineup — a new model gets correct cache pricing free. The READ rate
// stopped being universal with Opus 5.5 (5%, and 2.5% on the Fable/Mythos 5.1
// tier), so a row may override it via `cacheRead` — kept ON the PRICING row so
// a prefix-resolved alias inherits the right rate, with no second table.
//
// This is why they must be billed at all: aggregateOpUsage already sums
// cacheReadTokens / cacheCreateTokens per op, and trackUsage silently dropped
// both. A real 160-turn chat op read 13.85M cached tokens and was recorded at
// ~$19 instead of ~$27 — a 29% under-report, and structurally blind to the
// one metric that reveals a broken cache breakpoint.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic (dated + short aliases)
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.025 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.025 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
  "claude-sonnet-5": { input: 2, output: 10 },  // the 2026-08-31 intro rate became the standing rate
  "claude-opus-5": { input: 5, output: 25 },    // drop-in upgrade at Opus 4.8's pricing
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-3-5-20241022": { input: 0.80, output: 4 },
  // OpenAI / Codex (GPT-5.x — developers.openai.com/api/docs/pricing)
  // GPT-5.6 short-context tier; long-context (>~272k) bills ~2x, not modeled
  // gpt-6-astra: $10 in / $50 out, cached in $1 — exactly the 0.1x
  // CACHE_READ_MULTIPLIER above, so cached tokens price right with no extra
  // column. LIMIT: up to a 272K prompt those are the rates; ABOVE it OpenAI
  // charges 2x input and 1.5x output for the WHOLE request. This table is flat
  // {input, output} per model, so the tier is not modelled and a >272K prompt
  // under-reports — which now matters, because the session/daily spend caps read
  // these numbers, so the cap under-counts on those requests. Do not "fix" this
  // by inflating the base rate — that over-charges the common case; it needs a
  // tiered shape, tracked separately.
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-5.6": { input: 5, output: 30 }, // bare alias routes to Sol
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2.50, output: 15 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.50, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.50 },
  "gpt-4o": { input: 2.50, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
  "o3": { input: 2, output: 8 },
  "o3-pro": { input: 20, output: 80 },
  "o4-mini": { input: 1.10, output: 4.40 },
  // xAI (grok-4.3 + 4.20 family all $1.25/$2.50, cached $0.20 — x.ai/api)
  "grok-4.6": { input: 2.00, output: 6.00 }, // x.ai/api — released 2026-08-12, frontier model, 500k ctx, supersedes 4.5
  "grok-4.5": { input: 2.00, output: 6.00 }, // x.ai/api — smartest model, 500k ctx
  "grok-4.3": { input: 1.25, output: 2.50 },
  "grok-4.20-0309-reasoning": { input: 1.25, output: 2.50 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.50 },
  "grok-4.20-multi-agent-0309": { input: 1.25, output: 2.50 },
  "grok-code-fast-1": { input: 0.20, output: 1.50 },
  "grok-build-0.1": { input: 0.20, output: 1.50 }, // est — coding model, priced as grok-code-fast-1
  "grok-4": { input: 3, output: 15 },
  "grok-4-fast": { input: 0.20, output: 0.50 },
  "grok-4-heavy": { input: 5, output: 25 },
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.30, output: 0.50 },
  "grok-2": { input: 2, output: 10 },
  // Gemini (≤200k context tier — ai.google.dev/gemini-api/docs/pricing)
  "gemini-3.1-pro-preview": { input: 2, output: 12 }, // est — priced as gemini-3-pro
  "gemini-3-pro-preview": { input: 2, output: 12 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-pro-preview": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.5-flash-preview": { input: 0.15, output: 0.60 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  // Cerebras (OSS inference — est, not gate-required)
  "gpt-oss-120b": { input: 0.35, output: 0.75 },
  "zai-glm-4.7": { input: 0.40, output: 1.60 },
  // Local models (free)
  "llama": { input: 0, output: 0 },
  "mistral": { input: 0, output: 0 },
  "qwen": { input: 0, output: 0 },
  "deepseek": { input: 0, output: 0 },
  "phi": { input: 0, output: 0 },
  "gemma": { input: 0, output: 0 },
};

/** When the rates above were last verified against provider pricing pages.
 *  check:pricing-coverage warns once this is older than the staleness window —
 *  a nudge to re-check, since a hardcoded table can't know a provider repriced. */
export const PRICES_VERIFIED_AT = "2026-06-28";
