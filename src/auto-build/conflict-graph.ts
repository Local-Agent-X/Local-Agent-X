/**
 * Conflict-graph / wave scheduler for auto-build chunks.
 *
 * Canonical owner of "which auto-build chunks can run together." Given the
 * parsed chunks (see {@link ParsedChunk} in ./plan-parser), it computes an
 * ordered list of WAVES. Every chunk in a single wave is safe to build IN
 * PARALLEL; waves themselves run strictly in sequence. This is a PURE
 * function — no IO, git, DOM, clock, or randomness — so it is fully
 * unit-testable and deterministic.
 *
 * A chunk may join a wave only when BOTH hold:
 *   (a) every chunk in its `dependsOn` list already landed in a STRICTLY
 *       EARLIER wave (a dependency placed in the same wave does NOT count), and
 *   (b) its file footprint is pairwise-disjoint from every other chunk already
 *       in that wave.
 *
 * CONSERVATIVE-UNDECLARED RULE (load-bearing, from S1's parser contract):
 *   `footprint` is optional and the parser emits a concrete `[]` for
 *   "undeclared", but hand-written ParsedChunk literals may leave it
 *   `undefined`. BOTH `undefined` AND `[]` mean "undeclared → conservative":
 *   such a chunk is assumed to touch unknown files, so it CONFLICTS WITH
 *   EVERY other chunk and therefore occupies a wave ALONE (still in dependency
 *   order). Only chunks with a NON-EMPTY, pairwise-disjoint footprint may
 *   share a wave. Empty is never read as "touches nothing."
 *
 * FOOTPRINT-CONFLICT RULE (exact + directory containment; NO glob expansion):
 *   Two declared footprints conflict when any normalized path in one is either
 *   (1) exactly equal to a path in the other, or (2) a directory-SEGMENT
 *   prefix of a path in the other (e.g. `src/db` contains `src/db/schema.ts`;
 *   but `src/db` does NOT contain `src/dbutil.ts` — the boundary is a `/`).
 *   Normalization: trim, `\`→`/`, drop a leading `./`, collapse/trailing-strip
 *   slashes. LIMITATION — globs are treated as OPAQUE LITERAL strings: `src/db/*`
 *   only conflicts with an identical `src/db/*`, NOT with the concrete files it
 *   would match. We deliberately do not implement glob semantics (YAGNI, and
 *   getting it subtly wrong would be unsafe). Authors who want conservative
 *   serialization should declare concrete paths, a bare directory (no `*`), or
 *   leave the footprint undeclared. Over-conservatism only costs parallelism,
 *   never correctness.
 *
 * CYCLE / MISSING-DEP POLICY:
 *   `dependsOn` may form a cycle, name a chunk number that does not exist, or
 *   name the chunk's own number — any of which would strand a chunk forever.
 *   When a scheduling pass places zero chunks while chunks remain (a true
 *   deadlock — `satisfied` cannot grow, so the next pass would be identical),
 *   we FLUSH every remaining chunk one-per-wave in input order, ignoring their
 *   unsatisfiable deps, and mark each such wave `degraded: true`. This
 *   guarantees termination and that no chunk is ever dropped; `degraded` lets
 *   the caller warn that the ordering was forced rather than earned.
 *
 * INVARIANT: every input chunk appears in EXACTLY ONE wave — none dropped,
 * none duplicated. This is the load-bearing guarantee.
 */

import type { ParsedChunk } from "./plan-parser.js";

export interface ChunkWave {
  /** Chunks safe to build in parallel within this wave (input order preserved). */
  chunks: ParsedChunk[];
  /**
   * Present and `true` only for waves emitted by the cycle / missing-dep
   * fallback: their dependency ordering could not be satisfied, so they were
   * serialized one-per-wave to guarantee progress. Absent on normal waves.
   */
  degraded?: boolean;
}

/**
 * Plan build waves over the given chunks. Pure and deterministic: the same
 * input always yields the same waves. Tie-breaking is stable input order.
 * See the file header for the full contract.
 */
export function planWaves(chunks: ParsedChunk[]): ChunkWave[] {
  const n = chunks.length;
  const waves: ChunkWave[] = [];
  const placed = new Array<boolean>(n).fill(false);
  // Chunk numbers that have landed in a COMPLETED (strictly earlier) wave.
  const satisfied = new Set<number>();
  let remaining = n;

  while (remaining > 0) {
    const wave: ParsedChunk[] = [];
    const waveIndices: number[] = [];
    let waveExclusive = false; // an undeclared chunk has claimed this wave alone
    const wavePaths: string[] = []; // normalized paths already claimed this wave

    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      const chunk = chunks[i];
      if (!depsSatisfied(chunk, satisfied)) continue;

      if (wave.length === 0) {
        // First ready chunk in input order always seeds the wave.
        wave.push(chunk);
        waveIndices.push(i);
        if (isUndeclared(chunk)) {
          waveExclusive = true; // nobody else may join
        } else {
          for (const p of chunk.footprint!) wavePaths.push(normPath(p));
        }
        continue;
      }

      // Joining a wave that already has a seed chunk.
      if (waveExclusive) continue; // an undeclared chunk owns this wave alone
      if (isUndeclared(chunk)) continue; // undeclared chunks never share a wave
      const fp = chunk.footprint!.map(normPath);
      if (conflictsWith(fp, wavePaths)) continue;
      wave.push(chunk);
      waveIndices.push(i);
      for (const p of fp) wavePaths.push(p);
    }

    if (wave.length === 0) {
      // Deadlock: every remaining chunk has an unsatisfiable dependency (cycle,
      // missing target, or self-dep). `satisfied` cannot grow, so flush all
      // remaining chunks one-per-wave in input order and stop.
      for (let i = 0; i < n; i++) {
        if (placed[i]) continue;
        placed[i] = true;
        waves.push({ chunks: [chunks[i]], degraded: true });
        remaining--;
      }
      break;
    }

    for (const idx of waveIndices) placed[idx] = true;
    for (const chunk of wave) satisfied.add(chunk.number);
    waves.push({ chunks: wave });
    remaining -= wave.length;
  }

  return waves;
}

/** A chunk is "undeclared" (→ conservative, wave-alone) when footprint is undefined OR empty. */
function isUndeclared(chunk: ParsedChunk): boolean {
  return !chunk.footprint || chunk.footprint.length === 0;
}

/**
 * S4 footprint-subset DIAGNOSTIC. Given a chunk's DECLARED footprint and the
 * files it ACTUALLY changed (ChunkReport.changed), return the changed paths that
 * ESCAPE the declared footprint — covered by NO declared path under the EXACT
 * SAME normalization + directory-segment-containment rule the wave scheduler
 * uses to decide conflicts (normPath + pathsOverlap, reused here, not
 * reimplemented). This is how a real parallel conflict sneaks in: the scheduler
 * parallelized siblings believing their footprints were disjoint, but a chunk
 * that edits a file it never declared may collide with a sibling that WAS
 * disjoint on paper.
 *
 * Returns [] (never flags) when the footprint is UNDECLARED (undefined/empty):
 * such a chunk was already serialized ALONE by the conservative rule, so it
 * declared nothing to "escape" from — an escape verdict would be meaningless.
 */
export function footprintEscapes(footprint: string[] | undefined, changed: string[]): string[] {
  if (!footprint || footprint.length === 0) return [];
  const declared = footprint.map(normPath).filter(Boolean);
  if (declared.length === 0) return [];
  const escapes: string[] = [];
  for (const raw of changed) {
    const c = normPath(raw);
    if (!c) continue; // unparseable/empty changed entry — nothing to flag
    if (!declared.some((f) => pathsOverlap(c, f))) escapes.push(raw);
  }
  return escapes;
}

function depsSatisfied(chunk: ParsedChunk, satisfied: Set<number>): boolean {
  for (const dep of chunk.dependsOn) {
    if (!satisfied.has(dep)) return false;
  }
  return true;
}

/** True if any normalized path in `fp` overlaps any already-claimed path in the wave. */
function conflictsWith(fp: string[], wavePaths: string[]): boolean {
  for (const a of fp) {
    for (const b of wavePaths) {
      if (pathsOverlap(a, b)) return true;
    }
  }
  return false;
}

/** Overlap on ALREADY-NORMALIZED paths: exact equality or directory-segment containment. */
function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return true; // defensive: an empty path is treated conservatively
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * Normalize a repo-relative path for comparison. Idempotent.
 *
 * Case-folds (`.toLowerCase()`): on a case-INSENSITIVE filesystem (macOS —
 * LAX's platform — and Windows) `SRC/DB/x.ts` and `src/db/x.ts` are the SAME
 * file, so they MUST be seen as conflicting or the scheduler would parallelize
 * two chunks editing one file → merge corruption. Case-folding is strictly
 * more conservative: on case-sensitive Linux it may serialize two genuinely
 * different-case files that could have run in parallel, but serializing
 * non-conflicting chunks only costs ordering, never correctness.
 */
function normPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
