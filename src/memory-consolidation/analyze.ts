// Fact analysis primitives. Pure functions — no IO. Used by the
// consolidate cycle to dedup near-identical facts, find candidates
// worth promoting to long-term storage, and surface contradictions
// within an entity's facts.

import { existsSync, readFileSync } from "node:fs";
import { MIND_PATH, type FactEntry, type MergedFact } from "./types.js";
import { jaccardSimilarity } from "./utils.js";
import { loadSqliteFacts, loadAllRecentFacts } from "./load-facts.js";

export function mergeRelatedFacts(facts: FactEntry[]): MergedFact[] {
  if (facts.length < 2) return [];

  const merged: MergedFact[] = [];
  const used = new Set<number>();

  for (let i = 0; i < facts.length; i++) {
    if (used.has(i)) continue;
    const group: FactEntry[] = [facts[i]];
    used.add(i);

    for (let j = i + 1; j < facts.length; j++) {
      if (used.has(j)) continue;
      const sim = jaccardSimilarity(facts[i].content, facts[j].content);
      if (sim >= 0.7) {
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

export function getPromotionCandidates(): FactEntry[] {
  // Try SQLite facts first (from memory_save retain), fall back to daily log parsing
  let allFacts = loadSqliteFacts(30);
  if (allFacts.length === 0) allFacts = loadAllRecentFacts(30);
  const mindContent = existsSync(MIND_PATH)
    ? readFileSync(MIND_PATH, "utf-8")
    : "";

  // Count similar fact occurrences
  const occurrences = new Map<number, number>();
  for (let i = 0; i < allFacts.length; i++) {
    if (occurrences.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < allFacts.length; j++) {
      if (jaccardSimilarity(allFacts[i].content, allFacts[j].content) >= 0.6) {
        count++;
        occurrences.set(j, -1); // mark as duplicate
      }
    }
    occurrences.set(i, count);
  }

  const candidates: FactEntry[] = [];
  for (const [idx, count] of occurrences) {
    if (count >= 3 && !mindContent.includes(allFacts[idx].content.trim())) {
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
