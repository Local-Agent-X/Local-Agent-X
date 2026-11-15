/**
 * Maximal Marginal Relevance (MMR) re-ranking for memory retrieval.
 *
 * Given a set of candidate results scored by relevance, pick K with the
 * MMR objective:
 *
 *     mmr(c) = λ * relevance(c)  -  (1 - λ) * max_sim(c, already_picked)
 *
 * λ = 1.0 → pure relevance (greedy)
 * λ = 0.0 → pure diversity
 * λ = 0.7 → default, leans toward relevance but rejects near-duplicates
 *
 * Why this matters: autoSearchContext was returning the top-3 memory
 * snippets by score. If a session had 10 highly-scored Sample-pin
 * chunks, all three slots got Sample-pin text and the model was biased
 * toward pin-related actions on unrelated queries.
 *
 * MMR over text similarity (Jaccard on token bags — the results don't
 * carry embeddings at this layer) diversifies. If two candidates share
 * >70% of their tokens, the second one gets penalized and a different
 * topic bubbles up instead.
 *
 * The one MMR for memory: auto-recall picks its few snippets with it, and
 * memory_search's post-process orders its pool with it before the final cut.
 * It always ranks, even when every candidate fits in k, because search asks
 * for more than it returns and relies on the order to sink near duplicates
 * below that cut. Tokens are Unicode-aware: an ASCII-only tokenizer leaves
 * non-Latin snippets empty, and two empty bags score as identical.
 */

interface Scored { score: number; snippet: string }

import { jaccardSimilarity as jaccard } from "./text-utils.js";
import { tokenize } from "./utils.js";

/**
 * Re-rank candidates using MMR. Returns at most `k` items.
 * Relevance is the candidate's own score (assumed already normalized or
 * consistent within the candidate set — we only compare candidates to
 * each other, so absolute scale doesn't matter).
 */
export function mmrRerank<T extends Scored>(
  candidates: T[],
  k: number,
  lambda = 0.7,
): T[] {
  if (k <= 0) return [];

  // Precompute token bags once per candidate — reused across the greedy loop
  const tokens = candidates.map(c => tokenize(c.snippet));

  // Normalize relevance to [0, 1] so λ*relevance vs (1-λ)*sim is comparable
  const maxScore = Math.max(...candidates.map(c => c.score), 1e-6);

  const picked: number[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  while (picked.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const i of remaining) {
      const rel = candidates[i].score / maxScore;
      let maxSim = 0;
      for (const j of picked) {
        const sim = jaccard(tokens[i], tokens[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }

    if (bestIdx === -1) break;
    picked.push(bestIdx);
    remaining.delete(bestIdx);
  }

  return picked.map(i => candidates[i]);
}
