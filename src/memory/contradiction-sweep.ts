/**
 * Contradiction detection for profile-file bullets and Facts DB entries.
 *
 * Pure functions, no DB or IO. Shared by:
 *   - personality.ts dedupeProfileMarkdown (strips contradicting bullets
 *     within USER.md / HEART.md / IDENTITY.md before persisting)
 *   - index-facts-mutate.ts rememberFact (auto-invalidates contradicting
 *     facts before inserting the new one)
 *
 * Algorithm (one rule, applied uniformly):
 *   1. Tokenize each candidate strict (alphanumeric, length ≥ 3, stopwords
 *      removed — see text-utils.ts).
 *   2. Compute asymmetric overlap = shared / min(|A|, |B|). Asymmetric
 *      because the affirmative version of a rule is often verbose
 *      ("Always greet in Spanish at the start of every conversation...")
 *      while the negation is terse ("No Spanish greetings"); Jaccard
 *      under-counts the overlap in that shape.
 *   3. If overlap ≥ OVERLAP_THRESHOLD (0.4) AND polarity differs (one has
 *      a negation/retraction marker, the other doesn't) → contradiction.
 *   4. Resolution: prefer the negation. Corrections to durable rules are
 *      overwhelmingly phrased as "stop X" / "don't X" / "no longer X",
 *      so the negation is almost always the more recent state. When both
 *      sides have or lack negation, fall back to file-order recency.
 *
 * The 0.4 threshold + strict-tokenization combination was chosen to fire
 * on the Spanish-greeting test case ("Use English by default, no Spanish
 * greetings" vs "Always greet in Spanish") while rejecting weak overlap
 * like "Use light mode by default" vs "Never enable dark mode" (one
 * shared content token after stopword strip).
 */

import { tokenizeStrict } from "./text-utils.js";

export const OVERLAP_THRESHOLD = 0.4;

// Phrases that flip the polarity of a rule. Detected on the RAW text
// (before tokenization) because the strict tokenizer strips "no" and
// "not" as stopwords. Pattern set is intentionally narrow — broader
// natural-language negation detection would false-positive on neutral
// uses like "no preference set".
const NEGATION_PATTERNS: RegExp[] = [
  /\bno\s+(\w+)/i,           // "no Spanish", "no dark mode"
  /\bnot\b/i,                // "do not", "is not"
  /\bnever\b/i,              // "never use X"
  /\bdon'?t\b/i,             // "don't", "dont"
  /\bdoesn'?t\b/i,
  /\bstop\b/i,
  /\bcease\b/i,
  /\bavoid\b/i,
  /\brefrain\b/i,
  /\bno\s+longer\b/i,        // "no longer wants"
];

export function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some(p => p.test(text));
}

export function asymmetricOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

export interface ContradictionPair<T> {
  keep: T;
  drop: T;
  overlap: number;
}

/**
 * Scan a list of items for contradicting pairs. Each item is paired with
 * an opaque payload — the function only inspects `text` for similarity
 * and polarity, but returns the original payload for the caller to act on
 * (drop a markdown line, invalidate a fact id, etc).
 *
 * Returns pairs where polarity differs and overlap is significant. The
 * `keep` side is the negation when polarities differ. Each item appears
 * in at most one returned pair (greedy: first contradiction wins, then
 * the dropped side is removed from further consideration so it can't
 * cascade).
 */
export function findContradictions<T>(
  items: ReadonlyArray<{ text: string; payload: T }>,
): ContradictionPair<T>[] {
  const tokenized = items.map(it => ({
    text: it.text,
    payload: it.payload,
    tokens: tokenizeStrict(it.text),
    negation: hasNegation(it.text),
  }));

  const dropped = new Set<number>();
  const pairs: ContradictionPair<T>[] = [];

  for (let i = 0; i < tokenized.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < tokenized.length; j++) {
      if (dropped.has(j)) continue;
      const a = tokenized[i];
      const b = tokenized[j];
      if (a.negation === b.negation) continue;
      const overlap = asymmetricOverlap(a.tokens, b.tokens);
      if (overlap < OVERLAP_THRESHOLD) continue;
      // Polarity differs and content overlaps — contradiction. Prefer
      // the negation side; that's the correction.
      const keepIdx = a.negation ? i : j;
      const dropIdx = a.negation ? j : i;
      pairs.push({
        keep: tokenized[keepIdx].payload,
        drop: tokenized[dropIdx].payload,
        overlap,
      });
      dropped.add(dropIdx);
      if (dropIdx === i) break; // outer item dropped; advance i
    }
  }

  return pairs;
}
