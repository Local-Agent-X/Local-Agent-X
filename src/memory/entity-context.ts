/**
 * Per-turn entity recognition + inline fact recall for buildContextBlock.
 *
 * Owns the <known_entities> half of the free recall path: scan the user
 * message against known entity slugs, reinforce the matched entities'
 * facts, and render those facts INLINE so a bare mention ("merchhelm")
 * is answered from context instead of a memory_search tool round-trip.
 * Extracted from context.ts (which sits at the 400-LOC gate); context.ts
 * remains the only caller and the canonical injection seam.
 */

import type { MemoryIndex } from "./index-core.js";
import type { RetainedFact } from "./types.js";
import { factTrustSuffix } from "./fact-provenance-label.js";

/**
 * Most-mentioned-first scan window. Entities past this cutoff are
 * invisible to the free path — misses are logged as telemetry
 * `cutoffMisses` (recall-telemetry.ts) so widening it is an evidence
 * decision, not a guess.
 */
export const ENTITY_SCAN_LIMIT = 200;
/** Per-entity fact fetch cap — one name must not flood the prompt or
 * trigger a 100-row reinforce update. */
export const FACTS_PER_ENTITY = 5;

export interface EntityScanResult {
  mentionedEntities: string[];
  /** slug → facts fetched by recallByEntity (recall order preserved). */
  entityFacts: Map<string, RetainedFact[]>;
  /** The slugs the scan window actually covered (for miss detection). */
  scannedSlugs: Set<string>;
  totalEntities: number;
  scannedEntities: number;
}

function emptyScan(total = 0): EntityScanResult {
  return { mentionedEntities: [], entityFacts: new Map(), scannedSlugs: new Set(), totalEntities: total, scannedEntities: 0 };
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

  // Most-mentioned first — the old `ORDER BY entity_slug LIMIT 200`
  // silently ignored every entity past the first 200 alphabetically.
  const entitySlugs = memory["db"]
    .prepare(
      "SELECT entity_slug, COUNT(*) AS mentions FROM entity_mentions GROUP BY entity_slug ORDER BY mentions DESC LIMIT ?"
    )
    .all(ENTITY_SCAN_LIMIT) as Array<{ entity_slug: string }>;
  const scannedSlugs = new Set(entitySlugs.map((e) => e.entity_slug));
  const msgLower = userMessage.toLowerCase();
  const mentionedEntities = entitySlugs
    .map((e) => e.entity_slug)
    .filter((slug) => {
      if (!slug || slug.length < 3) return false;
      // Word-boundary match, not naive substring — `includes` reinforced
      // 'art' via 'start' and 'ann' via 'planning', bumping last_updated
      // on the wrong facts and corrupting hot-score ranking for the
      // ~30-day decay half-life.
      const esc = slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${esc}\\b`).test(msgLower);
    });

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
    scannedSlugs,
    totalEntities: stats.totalEntities,
    scannedEntities: entitySlugs.length,
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

/**
 * Telemetry-only: slugs that word-match the message but sit past the
 * top-N scan window — the entities the free path failed to recognize.
 * Single-token slugs only (indexed IN-list lookup); good enough to
 * measure whether the cutoff costs recognition before paying for a real
 * matcher. Never throws.
 */
export function findCutoffMisses(
  memory: MemoryIndex,
  userMessage: string | undefined,
  scan: EntityScanResult,
): string[] {
  try {
    if (!userMessage || scan.totalEntities <= scan.scannedEntities) return [];
    const words = [...new Set(userMessage.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].slice(0, 64);
    if (words.length === 0) return [];
    const placeholders = words.map(() => "?").join(",");
    const rows = memory["db"]
      .prepare(`SELECT DISTINCT entity_slug FROM entity_mentions WHERE entity_slug IN (${placeholders})`)
      .all(...words) as Array<{ entity_slug: string }>;
    return rows.map((r) => r.entity_slug).filter((s) => !scan.scannedSlugs.has(s));
  } catch {
    return [];
  }
}
