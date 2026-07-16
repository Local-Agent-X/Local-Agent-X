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
  // Empty / missing model identifier is a caller bug, not a legitimate
  // input. Silently returning a default tier ("strong" or "medium")
  // would mask the upstream plumbing bug — the agent would run with
  // the wrong iteration budget while nothing in the logs looks off.
  // Throw instead so the bad call site has to fix itself. Same
  // fail-closed posture as the canonical-loop context builder.
  if (!model) {
    throw new Error(
      `[classifyModel] empty/missing model identifier — caller must pass a real model string. ` +
      `Silent defaults would mis-classify the agent tier without surfacing the bug.`
    );
  }
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
  if (/claude-fable-5|claude-mythos-5|claude-opus-4|claude-sonnet-5|claude-sonnet-4-[6-9]|claude-sonnet-4-1[0-9]|claude-haiku-4-5/.test(m)) return "strong";
  if (/^o[34]($|-|\.)/.test(m)) return "strong";                 // o3/o4 family
  if (/gemini-(2\.5|3)/.test(m)) return "strong";
  // grok-4 / grok-4-fast — xAI's frontier tier. Earlier comment downgraded
  // it to medium on the theory that tool-use RLHF was thin; in practice the
  // tighter cap was making things worse (silently cut sidebar_clear,
  // model fell back to bash-echo narration). Give it the full catalog;
  // tool_search is in the schema either way for genuine over-50-tool cases.
  if (/^grok-4(\b|-|$)/.test(m)) return "strong";

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
 * Slots the medium cap reserves for tools the USER'S MESSAGE matched
 * (keyword/RAG), over and above the unconditional essentials. This is the
 * whole reason the cap isn't just ESSENTIAL_TOOLS_ORDER.length: without
 * headroom, a medium model gets the same 20 tools no matter what it's asked.
 *
 * Live 2026-07-15 (local qwen3.6:27b, "build me a side scroller"): the cap was
 * a hand-maintained 21 whose comment claimed "19 essentials + 2 intent slots",
 * but the list had since grown to 20 — so the real headroom was 1 slot, and
 * build_app lost it to whichever tool sorted earlier. The model knew build_app
 * existed, couldn't find it in its schema, and improvised bash("build_app …").
 * Nobody was wrong; the constant just drifted from the list it depends on.
 * Deriving it means appending an essential can never silently eat the headroom
 * again — that's the actual bug class, not the missing tool.
 */
export const MEDIUM_INTENT_SLOTS = 2;

/**
 * Gemini's OpenAI-compat endpoint cap. Historically this rode on the medium
 * count (they happened to both be 21), which silently coupled an ENDPOINT
 * limit to a MODEL-CAPACITY limit — bumping medium for model reasons would
 * shove Gemini further past Google's documented ceiling for unrelated reasons.
 * Pinned explicitly so the two move independently. 21 preserves the exact
 * behavior from when they were coupled; see toolCapTierForProvider.
 */
export const GEMINI_STRONG_TOOL_CAP = 21;

/**
 * Max tool count to send per model tier. Weak models cap aggressively
 * (~8 tools) to prevent 0-token paralysis. Medium models take every essential
 * plus MEDIUM_INTENT_SLOTS of message-matched headroom. Strong — no cap.
 */
export function maxToolsForTier(tier: ModelTier): number {
  switch (tier) {
    case "weak":   return 8;
    // Derived, never hand-tuned: essentials are unconditional, so the cap has
    // to be list-length + headroom or the headroom silently goes to zero the
    // next time someone appends an essential (which is exactly what happened).
    case "medium": return ESSENTIAL_TOOLS_ORDER.length + MEDIUM_INTENT_SLOTS;
    case "strong": return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Effective tool-cap tier for a (provider, model). Tool CAPACITY is a property
 * of the endpoint, not just model quality. Anthropic/OpenAI strong tiers take
 * the full inventory (prompt caching amortizes the schema tokens), but Gemini's
 * OpenAI-compat endpoint degrades hard past Google's documented 10-20 active
 * tools — with the full ~98-tool catalogue it returns empty STOP completions
 * every turn (live 2026-06-11: "narrates but never calls a tool"). Google's
 * guidance: "keep the active set to a maximum of 10-20" + "consider dynamic
 * tool selection". So Gemini caps at the medium count even though 2.5/3.x are
 * strong models — never ABOVE its own tier (a weak Gemini still caps weak).
 * Every other provider keeps its model-tier cap unchanged.
 */
export function toolCapTierForProvider(provider: string, model: string): ModelTier {
  const tier = classifyModel(model);
  if (provider === "gemini" && tier === "strong") return "medium";
  return tier;
}

/**
 * Effective tier for the canonical-loop SPIN GUARDS (loop-detection's
 * repeat / discovery / no-progress thresholds) — a different axis from the
 * tool-CATALOG tier. grok-4 reasons fine over a large catalog, so
 * classifyModel keeps it "strong" (shrinking its menu made it worse — see the
 * grok-4 note above), but it's still more prone to re-calling / narrating than
 * the Anthropic/OpenAI frontier, so it benefits from the tighter medium-tier
 * spin thresholds. Tighten the guards without touching the catalog.
 */
export function loopGuardTier(model: string): ModelTier {
  const tier = classifyModel(model);
  if (tier === "strong" && /^grok-4(\b|-|$)/.test(model.toLowerCase())) return "medium";
  return tier;
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
  // Flagship capability — "build me an app/game/site" is a primary reason this
  // product exists, so it cannot be left to compete for the intent slots. It
  // sits BELOW the weak-tier cut (first 8) on purpose: weak 1-13B models can't
  // drive a build loop, and promoting it above would evict memory_save from
  // every weak model's set. Medium+ is where builds actually land.
  // Live 2026-07-15: absent from this list, build_app fell out of a local 27B's
  // schema entirely and the model improvised bash("build_app --name …") — the
  // catalog-order intent slot went to another tool. See MEDIUM_INTENT_SLOTS.
  "build_app",
  // Profile + Facts DB writers — without these in the medium-tier set,
  // models like grok-4-fast that get a "stop X" / "use Y" preference
  // fall back to memory_save (daily log only) which doesn't trigger the
  // HEART.md / USER.md contradiction sweep, so contradictory rules
  // accumulate. memory_update_profile is the load-bearing one; the
  // others give the agent precise verbs for scalars / facts / retractions.
  "memory_update_profile", "memory_set_user_field", "remember", "forget",
  "web_fetch", "web_search",
  "glob", "grep",
  // Media gen — first-class capabilities for medium-tier providers (xAI
  // Grok via SuperGrok, Gemini, etc.). Used to be filter+RAG-gated which
  // meant "generate an image" would silently drop the tool when RAG
  // wasn't warmed yet or the cap squeezed it out. edit_image rides here too
  // so "edit this photo" reaches the model instead of falling back to a
  // from-scratch generate_image that never sees the source pixels.
  "generate_image", "edit_image", "generate_video",
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
  capOverride?: number,
): T[] {
  // capOverride lets an ENDPOINT limit (Gemini's compat cap) be expressed
  // without hijacking the tier's MODEL-capacity limit. tier still drives
  // description truncation, which is a model-comprehension concern.
  const cap = capOverride ?? maxToolsForTier(tier);
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
