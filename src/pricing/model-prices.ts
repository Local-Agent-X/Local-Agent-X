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
  "claude-fable-5": { input: 10, output: 50 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.025 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.025 },
  "claude-mythos-5": { input: 10, output: 50 }, // platform.claude.com models overview 2026-09-27: reads at the standard 10%
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
  "claude-sonnet-5": { input: 2, output: 10 },  // the 2026-08-31 intro rate became the standing rate
  "claude-opus-5": { input: 5, output: 25 },    // drop-in upgrade at Opus 4.8's pricing
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  // OpenAI / Codex (developers.openai.com/api/docs/pricing, read 2026-09-27).
  // Rows are ordered longest-id-first within a family: resolvePricing
  // prefix-matches in insertion order, so a bare "gpt-5" row must sit after
  // every "gpt-5.x" / "gpt-5-mini" row or a dated snapshot of those would
  // bill at gpt-5's rate.
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
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6": { input: 4, output: 20 }, // bare alias routes to Sol
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.4-mini": { input: 0.75, output: 4.50 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-pro": { input: 30, output: 180 }, // Responses API only; no cached-input rate
  "gpt-5.4": { input: 2.50, output: 15 },
  "gpt-5.2-pro": { input: 21, output: 168 }, // Responses API only; no cached-input rate
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-pro": { input: 15, output: 120 }, // Responses API only; no cached-input rate
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.5 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.25 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.25 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.25 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.5 },
  "o3-pro": { input: 20, output: 80 },
  "o3": { input: 2, output: 8, cacheRead: 0.25 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.25 },
  // xAI (docs.x.ai/docs/models, read 2026-09-27: grok-4.7 / 4.6 / 4.5 $2/$6;
  // grok-4.3 + the 4.20 family $1.25/$2.50, cached $0.20). The undated 4.20
  // ids and grok-code-fast are LiteLLM-only aliases of the dated rows, priced
  // the same; bare "grok-4.20" sits after its variants for the prefix match.
  "grok-4.7": { input: 2, output: 6, cacheRead: 0.25 }, // flagship per docs.x.ai, 500k ctx
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.25 }, // 500k ctx
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.15 }, // 500k ctx
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-0309-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-multi-agent-0309": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-non-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20-multi-agent": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-4.20": { input: 1.25, output: 2.5, cacheRead: 0.16 },
  "grok-code-fast-1": { input: 1, output: 2, cacheRead: 0.2 },
  "grok-code-fast": { input: 1, output: 2, cacheRead: 0.2 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2 }, // x.ai/api, verified 2026-09-27
  // Gemini (≤200k context tier — ai.google.dev/gemini-api/docs/pricing, read
  // 2026-09-27). 3.6 / 3.7 / 3.8 Flash are promotional through 2026-12-31 and
  // double on 2027-01-01 — recheck then.
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // Cerebras (OSS inference — est, not gate-required)
  "gpt-oss-120b": { input: 0.35, output: 0.75 },
  "qwen-3.8-27b": { input: 0.99, output: 1.49 }, // LiteLLM-only: inference-docs.cerebras.ai lists the model, not a rate
  // Local models (free)
  "llama": { input: 0, output: 0 },
  "mistral": { input: 0, output: 0 },
  "qwen": { input: 0, output: 0 },
  "deepseek": { input: 0, output: 0 },
  "phi": { input: 0, output: 0 },
  "gemma": { input: 0, output: 0 },
};

/** When the rates above were last verified against provider pricing pages.
 *  check:pricing-coverage rechecks every row it can match in LiteLLM's price
 *  file; this date covers the rows it can't, and it warns once they're older
 *  than the staleness window. */
export const PRICES_VERIFIED_AT = "2026-09-27";
