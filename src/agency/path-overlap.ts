/**
 * Whether two repo-relative paths name overlapping work: the same file, or one
 * a directory that contains the other. One rule for every place that asks
 * "would these two pieces of work touch the same files": the auto-build wave
 * scheduler (`src/auto-build/conflict-graph.ts`) and the claims agents make
 * on the files they change (`work-claims.ts`, ADR 0007).
 *
 * Globs are not expanded: `src/db/*` is an opaque string that overlaps only an
 * identical `src/db/*`. Declare a bare directory (`src/db`) to claim a tree.
 */

/**
 * Normalize a repo-relative path for comparison. Idempotent.
 *
 * Case-folds (`.toLowerCase()`): on a case-INSENSITIVE filesystem (macOS and
 * Windows) `SRC/DB/x.ts` and `src/db/x.ts` are the SAME file, so they MUST be
 * seen as overlapping. Case-folding is strictly more conservative: on
 * case-sensitive Linux it may call two different-case files one, which costs
 * a needless warning or serialization, never a missed clash.
 */
export function normRepoPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Overlap on ALREADY-NORMALIZED paths: exact equality or directory-segment
 *  containment (`src/db` contains `src/db/x.ts`, not `src/dbutil.ts`). */
export function repoPathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return true; // defensive: an empty path is treated conservatively
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}
