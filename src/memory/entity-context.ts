/**
 * Per-turn entity recognition + inline fact recall for buildContextBlock.
 *
 * Owns the <known_entities> half of the free recall path: scan the user
 * message against known entity slugs, reinforce the matched entities'
 * facts, and render those facts INLINE so a bare mention ("merchhelm")
 * is answered from context instead of a memory_search tool round-trip.
 * Extracted from context.ts, which remains the only caller and the canonical
 * injection seam.
 */

import type { MemoryIndex } from "./index-core.js";
import type { RetainedFact } from "./types.js";
import { factTrustSuffix } from "./fact-provenance-label.js";

/** Per-entity fact fetch cap — one name must not flood the prompt or
 * trigger a 100-row reinforce update. */
export const FACTS_PER_ENTITY = 5;
/** Longest slug, in words: the corpus's longest is five (`a-b-c-d-e`). */
const MAX_SLUG_WORDS = 5;
/** Bound parameters per IN-list query, well under SQLite's variable limit. */
const LOOKUP_BATCH = 500;

export interface EntityScanResult {
  mentionedEntities: string[];
  /** slug → facts fetched by recallByEntity (recall order preserved). */
  entityFacts: Map<string, RetainedFact[]>;
  totalEntities: number;
  scannedEntities: number;
}

function emptyScan(total = 0): EntityScanResult {
  return { mentionedEntities: [], entityFacts: new Map(), totalEntities: total, scannedEntities: 0 };
}

/**
 * Every slug the message could name: each run of one to MAX_SLUG_WORDS
 * consecutive words, joined the way slugify joins them (`bpc 157` and
 * `bpc-157` both give `bpc-157`). Word boundaries come from the split, so
 * `reta` is never found inside `retatrutide`.
 */
export function slugCandidates(message: string): string[] {
  const words = message.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_SLUG_WORDS && i + n <= words.length; n++) {
      const slug = words.slice(i, i + n).join("-");
      if (slug.length >= 3) out.add(slug);
    }
  }
  return [...out];
}

/** The candidates that are known entities, most-mentioned first. */
function knownSlugs(memory: MemoryIndex, candidates: string[]): string[] {
  const found: Array<{ entity_slug: string; mentions: number }> = [];
  for (let i = 0; i < candidates.length; i += LOOKUP_BATCH) {
    const batch = candidates.slice(i, i + LOOKUP_BATCH);
    found.push(...(memory["db"]
      .prepare(`SELECT entity_slug, COUNT(*) AS mentions FROM entity_mentions WHERE entity_slug IN (${batch.map(() => "?").join(",")}) GROUP BY entity_slug`)
      .all(...batch) as Array<{ entity_slug: string; mentions: number }>));
  }
  return found.sort((a, b) => b.mentions - a.mentions || a.entity_slug.localeCompare(b.entity_slug)).map((r) => r.entity_slug);
}

/**
 * Match the user message against known entity slugs and reinforce the
 * matched entities' facts (last_updated bump → hot-score jump), keeping
 * the fetched facts so the caller can render them inline instead of
 * discarding them post-reinforce. Must run BEFORE core_memory selection.
 */
export function scanMentionedEntities(memory: MemoryIndex, userMessage?: string): EntityScanResult {
  if (!userMessage || userMessage.trim().length === 0) return emptyScan();
  const stats = memory.getStats();
  if (stats.totalEntities === 0) return emptyScan();

  // Every known entity the message names, looked up by its words. A
  // most-mentioned top-200 window stood here: with 1,224 entities, a user's
  // own record of "reta" (rank 219) was never shown, and the agent answered
  // a dose question from an old chat about someone else's vial (2026-11-08).
  // Whole-word candidates, not substrings: `includes` once reinforced 'art'
  // via 'start', bumping the wrong facts' hot-score.
  const mentionedEntities = knownSlugs(memory, slugCandidates(userMessage));

  const entityFacts = new Map<string, RetainedFact[]>();
  const factIds = new Set<number>();
  for (const slug of mentionedEntities) {
    const facts = memory.recallByEntity(slug, FACTS_PER_ENTITY);
    entityFacts.set(slug, facts);
    for (const f of facts) if (f.id !== undefined) factIds.add(f.id);
  }
  if (factIds.size > 0) memory.reinforceFacts([...factIds]);

  return {
    mentionedEntities,
    entityFacts,
    totalEntities: stats.totalEntities,
    scannedEntities: stats.totalEntities,
  };
}

export interface KnownEntitiesBody {
  body: string;
  factsRendered: number;
  factsDeduped: number;
  bytes: number;
}

/**
 * Render the <known_entities> body. Entities whose facts survive the
 * dedup (not already rendered in <core_memory> this turn) get an inline
 * fact block; entities with nothing left to show fall back to the legacy
 * bare name list, byte-identical to the pre-inline format when no facts
 * render at all. Byte-capped so per-turn prompt cost stays bounded —
 * an entity whose block would overflow the cap degrades to a bare name,
 * it is never truncated mid-fact. Trust suffixes are part of the fact
 * line and count against the cap: a fact must never render without its
 * provenance label (the memory-taint contract).
 */
export function renderKnownEntitiesBody(
  scan: EntityScanResult,
  excludeFactIds: Set<number>,
  maxBytes: number,
): KnownEntitiesBody {
  let factsRendered = 0;
  let factsDeduped = 0;
  let bytes = 0;
  const blocks: string[] = [];
  const bare: string[] = [];

  for (const slug of scan.mentionedEntities) {
    const kept: string[] = [];
    for (const f of scan.entityFacts.get(slug) ?? []) {
      if (f.id !== undefined && excludeFactIds.has(f.id)) { factsDeduped++; continue; }
      kept.push(`- ${f.content}${factTrustSuffix(f.sourceFile)}`);
    }
    if (kept.length === 0) { bare.push(slug); continue; }
    const block = `${slug}:\n${kept.join("\n")}`;
    if (bytes + block.length + 1 > maxBytes) { bare.push(slug); continue; }
    bytes += block.length + 1;
    factsRendered += kept.length;
    blocks.push(block);
  }

  const parts = [...blocks];
  if (bare.length > 0) {
    parts.push(blocks.length > 0 ? `also mentioned: ${bare.join(", ")}` : bare.join(", "));
  }
  const body = parts.join("\n");
  return { body, factsRendered, factsDeduped, bytes: body.length };
}
