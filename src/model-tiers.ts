/**
 * Model tier classification.
 *
 * Different models have wildly different tool-use robustness. A 109-tool
 * prompt that GPT-4o and Claude Opus handle cleanly will produce 0 tokens
 * from grok-3-mini, qwen2:7b, or other small models. We classify by tier
 * so the agent pipeline can apply precautions: shrink tool catalogs,
 * tighten loop detection, warn in UI, etc.
 */

export type ModelTier = "strong" | "medium" | "weak";

/**
 * Classify a model by name heuristic. When in doubt → medium.
 *
 * Strong: Proven tool-use at 100+ tool catalogs. GPT-5.x, Claude 4.x,
 *         o-series, Gemini 2.5+.
 * Weak:   Small local models, chat-only tiers, known 0-token-on-large-tool-set
 *         models. 7B/8B/13B local. grok-3-mini (not reasoning).
 * Medium: Everything else — Grok 3/4, Gemini 2.0, 32B+ local.
 */
export function classifyModel(model: string): ModelTier {
  // Empty / missing model identifier should NOT silently fall through to
  // the "medium" catch-all below — that buckets unknowns into the
  // restrictive 15-iteration / shrink-tools pipeline that's only correct
  // for known weak-tool-RLHF models like grok-4. A canonical-loop call
  // that arrives with ctx.model === "" (plumbing bug) was killing strong-
  // model turns at 15 iterations even though the user's actual model
  // would budget 25. Treat unknown-because-empty as strong — when we
  // truly don't know, default to giving the agent room to work.
  if (!model) return "strong";
  const m = model.toLowerCase();

  // Weak: small local models + known flaky tiers
  if (/:([1-9]b|1[0-3]b)(\b|-|$)/.test(m)) return "weak";       // 1B–13B local
  if (/\bqwen2?:7b\b/.test(m)) return "weak";
  if (/^grok-3-mini$/.test(m)) return "weak";                    // not the -reasoning variant
  if (/gpt-4o-mini|gpt-3\.5/.test(m)) return "weak";
  if (/gemini-(1|2\.0)-flash/.test(m)) return "weak";
  if (/haiku(?!-4-5)/.test(m)) return "weak";                    // old haiku, not 4.5

  // Strong: flagship tool-use models proven to reason over 100+ tool catalogs.
  if (/gpt-5(\.\d+)?($|-(?!mini))/.test(m)) return "strong";     // gpt-5.x, not -mini
  if (/claude-opus-4|claude-sonnet-4-[6-9]|claude-sonnet-4-1[0-9]|claude-haiku-4-5/.test(m)) return "strong";
  if (/^o[34]($|-|\.)/.test(m)) return "strong";                 // o3/o4 family
  if (/gemini-(2\.5|3)/.test(m)) return "strong";

  // grok-4 is smart but xAI's tool-use RLHF is thinner than OpenAI/Anthropic —
  // it paralyzes on full 100+ tool catalogs. Keeping as "medium" (cap 15)
  // gives it a focused set it can actually reason over quickly.
  // Falls through to medium default.

  return "medium";
}

export function isWeakModel(model: string): boolean {
  return classifyModel(model) === "weak";
}

export function isMediumOrWeak(model: string): boolean {
  const t = classifyModel(model);
  return t === "weak" || t === "medium";
}

/**
 * Max tool count to send per model tier. Weak models cap aggressively
 * (~8 tools) to prevent 0-token paralysis. Medium models cap at ~15
 * (covers most agent flows without overwhelming). Strong — no cap.
 */
export function maxToolsForTier(tier: ModelTier): number {
  switch (tier) {
    case "weak":   return 8;
    case "medium": return 15;
    case "strong": return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Priority-ordered list of tools that MUST stay in the shrunken set
 * when we cap. Covers the 80% of agent operations.
 */
export const ESSENTIAL_TOOLS_ORDER: readonly string[] = [
  "read", "write", "edit", "bash",
  "http_request", "browser",
  "self_edit",                      // agent self-repair via Claude Code
  "memory_save", "memory_search",
  "web_fetch", "web_search",
  "ask_user",
  "glob", "grep",
];

/**
 * Shrink a tool list to the tier's cap, preserving essential tools first.
 * If the user's message matched specific tools via keyword/RAG, those
 * are included ahead of lower-priority essentials (so "send an email"
 * keeps email_send even if it's not in the essentials list).
 *
 * For weak tier, also truncates descriptions to the first ~150 chars —
 * weak models skim long descriptions and get distracted by nuance.
 * Shorter is more decisive.
 */
export function shrinkToolsForTier<T extends { name: string; description: string }>(
  tools: T[],
  tier: ModelTier,
  allTools?: T[],
): T[] {
  const cap = maxToolsForTier(tier);
  const maybeTruncate = (t: T): T => {
    if (tier !== "weak" || t.description.length <= 150) return t;
    // Keep only the first sentence, falling back to hard cut at 150
    const firstSentence = t.description.match(/^[^.!?]{10,}[.!?]/)?.[0];
    const desc = firstSentence && firstSentence.length <= 180 ? firstSentence : t.description.slice(0, 140) + "…";
    return { ...t, description: desc };
  };

  if (tools.length <= cap && !allTools) return tools.map(maybeTruncate);

  // Guarantee essentials from the full catalog (if provided) — the caller's
  // prefilter may have dropped read/write/bash/http_request because they
  // didn't keyword-match, and we need them available regardless.
  const essentialSource = new Map<string, T>();
  for (const t of tools) essentialSource.set(t.name, t);
  if (allTools) for (const t of allTools) if (!essentialSource.has(t.name)) essentialSource.set(t.name, t);

  const kept: T[] = [];
  const seen = new Set<string>();

  // 1. Pull essentials in priority order (from full catalog if needed)
  for (const name of ESSENTIAL_TOOLS_ORDER) {
    const t = essentialSource.get(name);
    if (t && !seen.has(name)) { kept.push(maybeTruncate(t)); seen.add(name); }
    if (kept.length >= cap) return kept;
  }
  // 2. Then the user-intent-matched tools (keyword/RAG selections)
  for (const t of tools) {
    if (!seen.has(t.name)) { kept.push(maybeTruncate(t)); seen.add(t.name); }
    if (kept.length >= cap) break;
  }
  return kept;
}
