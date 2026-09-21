/**
 * Model tier classification.
 *
 * Different models have wildly different tool-use robustness. A 109-tool
 * prompt that GPT-4o and Claude Opus handle cleanly will produce 0 tokens
 * from grok-3-mini, qwen2:7b, or other small models. We classify by tier
 * so the agent pipeline can apply precautions: shrink tool catalogs,
 * tighten loop detection, warn in UI, etc.
 */

import { modelProfileTier } from "./local-runtimes/model-profile.js";

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
  // A declared profile (config/model-profiles, or a user's own) outranks every
  // name heuristic below: the tier there was measured, the regexes guess from
  // a parameter count in the name.
  const declared = modelProfileTier(model);
  if (declared) return declared;

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
  if (/claude-fable-5|claude-mythos-5|claude-opus-5|claude-opus-4|claude-sonnet-5|claude-sonnet-4-[6-9]|claude-sonnet-4-1[0-9]|claude-haiku-4-5/.test(m)) return "strong";
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
