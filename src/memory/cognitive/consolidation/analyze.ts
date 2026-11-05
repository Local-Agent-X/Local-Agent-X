// Fact analysis primitives. Used by the consolidate cycle to dedup
// near-identical facts, surface recurring fact clusters, and detect
// contradictions within an entity's facts.

import { type FactEntry, type MergedFact } from "./types.js";
import { jaccardSimilarity } from "./utils.js";
import { tokenizeBasic, jaccardSimilarity as jaccardOfSets } from "../../text-utils.js";
import { loadSqliteFacts, loadAllRecentFacts } from "./load-facts.js";

/** Each fact's words, split once. The pair loops below split both texts for every
 *  pair: with ~2,300 facts from the last 30 days that was a 1.1-1.3 s freeze of the
 *  server's one thread on every consolidation run, cutting a voice call off mid-reply
 *  (2026-11-05). */
const wordSetsOf = (facts: FactEntry[]): Set<string>[] => facts.map((f) => new Set(tokenizeBasic(f.content)));

/** Two word sets have Jaccard similarity of at least `min`. Sets of very different
 *  size cannot reach it (|A∩B|/|A∪B| ≤ smaller/larger), so most pairs end here. */
function similarAtLeast(a: Set<string>, b: Set<string>, min: number): boolean {
  const smaller = Math.min(a.size, b.size);
  const larger = Math.max(a.size, b.size);
  if (larger > 0 && smaller < min * larger) return false;
  return jaccardOfSets(a, b) >= min;
}

export function mergeRelatedFacts(facts: FactEntry[]): MergedFact[] {
  if (facts.length < 2) return [];

  const merged: MergedFact[] = [];
  const used = new Set<number>();
  const words = wordSetsOf(facts);

  for (let i = 0; i < facts.length; i++) {
    if (used.has(i)) continue;
    const group: FactEntry[] = [facts[i]];
    used.add(i);

    for (let j = i + 1; j < facts.length; j++) {
      if (used.has(j)) continue;
      if (similarAtLeast(words[i], words[j], 0.7)) {
        group.push(facts[j]);
        used.add(j);
      }
    }

    if (group.length > 1) {
      // Keep the most detailed version (longest content)
      const best = group.reduce((a, b) =>
        a.content.length >= b.content.length ? a : b
      );
      const maxConfidence = Math.min(
        1,
        Math.max(...group.map((g) => g.confidence)) + 0.05
      );
      merged.push({
        original: group,
        merged: best.content,
        confidence: maxConfidence,
      });
    }
  }

  return merged;
}

// Filter out operational noise — action confirmations, tool outputs,
// internal metadata, and any chat transcript that leaked through the
// parser. NOT facts worth remembering long-term.
const NOISE_PATTERNS = [
  /^\[chat-[a-z0-9-]+\]/i,           // Session ID prefix
  /^\[(?:ide|session|tg|cron|wa)-[a-z0-9-]+\]/i, // Other session-id prefixes
  /^Agent:/i,                         // Agent response logs
  /^User:/i,                          // Raw user message captured as fact
  /^User (?:said|asked|wrote|shared|sent|told|replied)/i, // "User shared: ..." style capture
  /\b(pinned|unpinned|removed|added|switched|flipped|done)\b.*\b(sidebar|theme|light|dark|mode)\b/i,  // UI action confirmations
  /\b(BLOCKED|Tool result|INJECTION WARNING|EXTERNAL_UNTRUSTED)/i,  // Tool/security noise
  /^User introduced themselves/i,     // Redundant — already in USER.md
  /\b(renamed to|gayatron|shiiit)\b/i, // Test/garbage names
  /\brestarting\b/i,                  // Server restarts
];

// Surface fact clusters seen ≥3 times — used only for the consolidation
// report stats. The clusters already live in the Facts DB; this is a
// reflection metric, not a promotion gate.
export function getPromotionCandidates(): FactEntry[] {
  // Try SQLite facts first (from memory_save retain), fall back to daily log parsing
  let allFacts = loadSqliteFacts(30);
  if (allFacts.length === 0) allFacts = loadAllRecentFacts(30);

  // Count similar fact occurrences
  const words = wordSetsOf(allFacts);
  const occurrences = new Map<number, number>();
  for (let i = 0; i < allFacts.length; i++) {
    if (occurrences.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < allFacts.length; j++) {
      if (similarAtLeast(words[i], words[j], 0.6)) {
        count++;
        occurrences.set(j, -1); // mark as duplicate
      }
    }
    occurrences.set(i, count);
  }

  const candidates: FactEntry[] = [];
  for (const [idx, count] of occurrences) {
    if (count >= 3) {
      const text = allFacts[idx].content;
      const isNoise = NOISE_PATTERNS.some(p => p.test(text));
      if (!isNoise) {
        candidates.push(allFacts[idx]);
      }
    }
  }

  return candidates;
}

export function countContradictions(group: FactEntry[]): number {
  let count = 0;
  const locationPatterns = /\b(lives?\s+in|moved?\s+to|based\s+in|from)\b/i;
  const employmentPatterns = /\b(works?\s+(at|for)|job\s+is|hired\s+at|left)\b/i;
  const statusPatterns = /\b(married|single|dating)\b/i;

  const patterns = [locationPatterns, employmentPatterns, statusPatterns];

  for (const pattern of patterns) {
    const matching = group.filter((f) => pattern.test(f.content));
    if (matching.length > 1) {
      // Multiple facts about same category for same entity — potential contradiction
      for (let i = 0; i < matching.length; i++) {
        for (let j = i + 1; j < matching.length; j++) {
          const sim = jaccardSimilarity(matching[i].content, matching[j].content);
          if (sim < 0.5) count++; // Low similarity = likely contradiction
        }
      }
    }
  }

  return count;
}
