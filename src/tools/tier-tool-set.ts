/**
 * Shaping a tool set for a model tier: how many tools a tier can take, which
 * ones are guaranteed, which must travel together, and how descriptions are
 * compacted on the way out.
 *
 * Split from model-tiers.ts, which had grown to two jobs and past the 400-LOC
 * gate. That file answers "what tier is this model"; this one answers "what
 * tools does a tier get". The second question is where the caps, the reserve
 * and the companion closure live, and it is the one that kept costing
 * capability (EXP-7: a weak model with zero slots for the task, and a 27B
 * shipped delete_file without its undo).
 */
import { classifyModel, type ModelTier } from "../model-tiers.js";
import { companionsFor } from "./tool-companions.js";

export const MEDIUM_INTENT_SLOTS = 2;

/**
 * Slots inside a tier's cap that the ESSENTIALS may not take, reserved for
 * tools the MESSAGE actually calls for.
 *
 * ESSENTIAL_TOOLS_ORDER is 29 long and the weak cap is 8, so a weak model got
 * the first 8 entries and nothing else — zero slots for the task. Measured
 * 2026-09-21 (EXP-7, qwen3:8b): "delete exactly this file" went 3/3 → 0/3 and
 * the model called NO tool at all, because `delete_file` is not in the
 * essentials at any position and there was no room left for it to arrive. The
 * re-rank computed which tools the task needed and the fill order threw the
 * answer away.
 *
 * Weak reserves 3 of its 8: read/write/edit/bash/http_request stay
 * guaranteed, and browser/self_edit/memory_save now have to be relevant to
 * ship — which is the right trade at a cap this tight. Medium already has
 * headroom (MEDIUM_INTENT_SLOTS) and its EXP-7 failure was a companion
 * problem, not a headroom one, so it is left alone until measured.
 */
export const TASK_SLOT_RESERVE_BY_TIER: Readonly<Record<ModelTier, number>> = {
  weak: 3,
  medium: 0,
  strong: 0,
};

/**
 * Gemini's OpenAI-compat endpoint cap. Historically this rode on the medium
 * count (they happened to both be 21), which silently coupled an ENDPOINT
 * limit to a MODEL-CAPACITY limit — bumping medium for model reasons would
 * shove Gemini further past Google's documented ceiling for unrelated reasons.
 * Pinned explicitly so the two move independently. 21 preserves the exact
 * behavior from when they were coupled; see toolCapTierForProvider.
 */
export const GEMINI_STRONG_TOOL_CAP = 21;

/** The one tool that reaches every other tool; never counted against a cap. */
export const DISCOVERY_TOOL = "tool_search";

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
  // Deliverable producers, here for the same reason build_app is: when the
  // user asks for the artifact ITSELF ("make me a deck/doc/sheet/pdf"), the
  // tool that produces it is the whole task, and a medium model has only
  // MEDIUM_INTENT_SLOTS of headroom to find it. Live 2026-09-16: across 27
  // muse turns the two slots went to edit_lines+multi_edit on 21 of them —
  // both redundant with the essential `edit` — and `presentation` won a slot
  // exactly once. Asked for a PowerPoint on a turn where it lost, the model
  // had no way to make one, so it improvised `write("…​.pptx", "placeholder")`
  // and reported the deck as built. These are the family umbrellas (one tool,
  // many actions), so four names buy every create/edit/read action.
  "presentation", "document", "spreadsheet", "pdf",
  // The credential path, for the same reason the media tools are here and not
  // behind the intent filter: when it is missing the model does not degrade
  // gracefully, it degrades DANGEROUSLY. Live 2026-09-08, a medium local model
  // asked to deploy with a vault-stored token: clipboard_write_from_secret was
  // filtered out, so it tried to read ~/.vercel/auth.json (tainting the session
  // and blocking its own egress), then finished by asking the user to "paste
  // the token value here" in plain chat. These three are the only route from a
  // stored credential to a working command that never puts the value in the
  // model's context, and list_secrets is what lets it know the credential is
  // there at all.
  "list_secrets", "clipboard_write_from_secret", "request_secret",
];

/** Longest parameter `description` a medium/weak schema keeps verbatim. */
export const COMPACT_PARAM_DESCRIPTION_MAX = 120;

/** Shape shrinkToolsForTier compacts. Structural so tests and the request
 *  pipeline's mapped tool objects both fit; ToolDefinition satisfies it. */
export interface TierShrinkable {
  name: string;
  description: string;
  compactDescription?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Shorten one parameter description: first sentence when that fits the cap,
 * else a hard cut. Types, enums, required and every other key are untouched,
 * so the schema still validates exactly as before — only prose is cut.
 */
function compactParamDescription(desc: string): string {
  if (desc.length <= COMPACT_PARAM_DESCRIPTION_MAX) return desc;
  const firstSentence = desc.match(/^[^.!?]{10,}[.!?]/)?.[0];
  if (firstSentence && firstSentence.length <= COMPACT_PARAM_DESCRIPTION_MAX) return firstSentence;
  return desc.slice(0, COMPACT_PARAM_DESCRIPTION_MAX - 1).trimEnd() + "…";
}

/**
 * Copy of a JSON-schema subtree with over-long `description` strings shortened.
 * Recurses through `properties`, `items` and the anyOf/oneOf/allOf branches;
 * never mutates the input (the catalog object is shared across tiers).
 */
export function compactSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (typeof out.description === "string") out.description = compactParamDescription(out.description);
  const props = out.properties;
  if (props && typeof props === "object") {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      next[k] = v && typeof v === "object" ? compactSchemaDescriptions(v as Record<string, unknown>) : v;
    }
    out.properties = next;
  }
  if (out.items && typeof out.items === "object" && !Array.isArray(out.items)) {
    out.items = compactSchemaDescriptions(out.items as Record<string, unknown>);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = out[key];
    if (Array.isArray(branches)) {
      out[key] = branches.map((b) => (b && typeof b === "object" ? compactSchemaDescriptions(b as Record<string, unknown>) : b));
    }
  }
  return out;
}

/**
 * Shrink a tool list to the tier's cap, preserving essential tools first.
 * If the user's message matched specific tools via keyword/RAG, those
 * are included ahead of lower-priority essentials (so "send an email"
 * keeps email_send even if it's not in the essentials list).
 *
 * Medium and weak tiers also get COMPACT schemas: the tool's authored
 * `compactDescription` replaces the Claude-length `description`, and parameter
 * descriptions over COMPACT_PARAM_DESCRIPTION_MAX chars are shortened. Without
 * this, the 23-tool medium manifest was ~13.6k tokens — a fifth of a 65k local
 * window — almost all of it prose written for a frontier model. Fallbacks when
 * no compact text exists: medium keeps the full description (an unwritten
 * compact text must never degrade a tool), weak keeps the historical
 * first-sentence/140-char truncation — weak models skim long descriptions and
 * get distracted by nuance. Strong is returned untouched, same object.
 */
export function shrinkToolsForTier<T extends TierShrinkable>(
  tools: T[],
  tier: ModelTier,
  allTools?: T[],
  capOverride?: number,
): T[] {
  // capOverride lets an ENDPOINT limit (Gemini's compat cap) be expressed
  // without hijacking the tier's MODEL-capacity limit. tier still drives
  // description compaction, which is a model-comprehension concern.
  const cap = capOverride ?? maxToolsForTier(tier);
  const truncateWeak = (desc: string): string => {
    if (desc.length <= 150) return desc;
    // Keep only the first sentence, falling back to hard cut at 150
    const firstSentence = desc.match(/^[^.!?]{10,}[.!?]/)?.[0];
    return firstSentence && firstSentence.length <= 180 ? firstSentence : desc.slice(0, 140) + "…";
  };
  const maybeTruncate = (t: T): T => {
    if (tier === "strong") return t;
    const description = t.compactDescription
      ?? (tier === "weak" ? truncateWeak(t.description) : t.description);
    const parameters = t.parameters ? compactSchemaDescriptions(t.parameters) : t.parameters;
    return { ...t, description, parameters };
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

  // Essentials may not spend the whole budget: a tier with a tight cap needs
  // room for what the MESSAGE asked for. See TASK_SLOT_RESERVE_BY_TIER.
  const essentialBudget = Math.max(1, cap - (TASK_SLOT_RESERVE_BY_TIER[tier] ?? 0));

  // 1. Essentials in priority order (from the full catalog if needed), but
  //    only up to the essentials budget.
  for (const name of ESSENTIAL_TOOLS_ORDER) {
    const t = essentialSource.get(name);
    if (t && !seen.has(name)) { kept.push(maybeTruncate(t)); seen.add(name); }
    if (kept.length >= essentialBudget) break;
  }
  // 2. Then the message-relevant tools, in the order the caller ranked them.
  if (kept.length < cap) {
    for (const t of tools) {
      if (!seen.has(t.name)) { kept.push(maybeTruncate(t)); seen.add(t.name); }
      if (kept.length >= cap) break;
    }
  }
  // 3. Backfill any essentials the reserve held back, if relevance left room.
  if (kept.length < cap) {
    for (const name of ESSENTIAL_TOOLS_ORDER) {
      const t = essentialSource.get(name);
      if (t && !seen.has(name)) { kept.push(maybeTruncate(t)); seen.add(name); }
      if (kept.length >= cap) break;
    }
  }
  return withDiscovery(withCompanions(kept, essentialSource, seen, maybeTruncate), essentialSource, seen, maybeTruncate);
}

/**
 * tool_search is the INDEX, not a capability, so it never competes for a slot.
 *
 * Every trimmed schema tells the model what to do about a tool it cannot see —
 * arg-validation's unknown-tool text ("call tool_search to load it") and the
 * deferred-tool manifest both say so, and the manifest's stated guarantee is
 * that every available tool is REACHABLE. All of that is void when the reaching
 * mechanism is itself trimmed, which is what happened: tool_search sits at
 * catalog position 17, the two medium intent slots go to whatever comes first
 * in catalog order, and the only re-add lived inside a Gemini-only branch. A
 * local 27B asked for a deck with photos was told to run image_search, did not
 * have it, was told to call tool_search, did not have that either, and shipped
 * the deck with no images (2026-09-19).
 *
 * Kept OUTSIDE the cap rather than added to ESSENTIAL_TOOLS_ORDER so it cannot
 * evict a capability at the weak tier, where the cap of 8 truncates mid-list.
 */
/**
 * A tool whose own output promises a counterpart brings that counterpart, cap
 * or no cap. Same argument as withDiscovery below: a capability limit may
 * decide how MUCH a model can do and must never void a guarantee the product
 * already made. `delete_file` tells the user the file can be restored; EXP-7
 * shipped that sentence without `restore_file` and the 27B's three recovered
 * deletions became three unrecovered ones. See tools/tool-companions.ts.
 */
function withCompanions<T extends TierShrinkable>(
  kept: T[],
  source: Map<string, T>,
  seen: Set<string>,
  maybeTruncate: (t: T) => T,
): T[] {
  const needed = companionsFor(seen);
  if (needed.length === 0) return kept;
  const out = [...kept];
  for (const name of needed) {
    const t = source.get(name);
    if (t) { out.push(maybeTruncate(t)); seen.add(name); }
  }
  return out;
}

function withDiscovery<T extends TierShrinkable>(
  kept: T[],
  source: Map<string, T>,
  seen: Set<string>,
  maybeTruncate: (t: T) => T,
): T[] {
  if (seen.has(DISCOVERY_TOOL)) return kept;
  const discovery = source.get(DISCOVERY_TOOL);
  return discovery ? [...kept, maybeTruncate(discovery)] : kept;
}
