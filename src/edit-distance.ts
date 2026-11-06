/**
 * How many single-character edits (insert, delete, substitute) turn one string
 * into another. The one implementation: a mistyped tool name resolved from a
 * model's text (canonical-loop/adapters/tool-call-text-repair.ts), a near-miss
 * in tool_search (tools/registry.ts), and a sidebar pin's "did you mean"
 * (routes/settings/preferences.ts).
 */

/** Two-row Levenshtein with an early bail once the distance must exceed `cap`. */
export function levenshtein(a: string, b: string, cap = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
