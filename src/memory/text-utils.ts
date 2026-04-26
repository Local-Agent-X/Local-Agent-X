/**
 * Shared text-similarity primitives for the memory subsystem.
 *
 * Two tokenizers, intentionally distinct:
 *   - tokenizeBasic: punctuation→space, length > 2, no stopwords.
 *     Used for fact-merge dedup and tier query-match where stopwords carry signal.
 *   - tokenizeStrict: alpha-numeric only, length ≥ 3, common-word stopwords removed.
 *     Used for diversity scoring (MMR), where "the/and/is" would dominate Jaccard.
 *
 * Plus jaccardSimilarity, which works on any Iterable<string>.
 */

const STRICT_STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","at","by","to","in","on","for","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","this","that","these","those","i","you",
  "he","she","it","we","they","my","your","his","her","its","our","their","me","him","us","them",
  "not","no","so","up","out","as","with","from","about","into","over","under","also","then","than",
]);

/** Lowercase, replace non-word/space with space, split, drop tokens of length ≤ 2. */
export function tokenizeBasic(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Lowercase, split on non-alphanumeric, keep tokens of length ≥ 3 that aren't stopwords. */
export function tokenizeStrict(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STRICT_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|.
 * Returns 1 when both empty, 0 when exactly one is empty.
 */
export function jaccardSimilarity(a: Iterable<string>, b: Iterable<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
