import { describe, expect, it } from "vitest";
import { planWaves, type ChunkWave } from "./conflict-graph.js";
import type { ParsedChunk } from "./plan-parser.js";

/**
 * Build a ParsedChunk literal for tests. `footprint` is passed through
 * verbatim when the key is present (so `{ footprint: undefined }` stays
 * undefined and `{ footprint: [] }` stays empty — both must be treated as
 * "undeclared"); omit the key entirely to default to `[]`.
 */
function mk(number: number, opts: Partial<ParsedChunk> = {}): ParsedChunk {
  return {
    number,
    title: opts.title ?? `Chunk ${number}`,
    phase: opts.phase ?? "Phase A",
    klass: opts.klass ?? "mixed",
    slice: opts.slice ?? "slice",
    dependsOn: opts.dependsOn ?? [],
    footprint: "footprint" in opts ? opts.footprint : [],
    scenarios: opts.scenarios ?? "—",
    doneWhen: opts.doneWhen ?? "done",
    rawSection: opts.rawSection ?? "",
  };
}

/** Flatten waves into their chunks, wave order preserved. */
function flat(waves: ChunkWave[]): ParsedChunk[] {
  return waves.flatMap((w) => w.chunks);
}

/** The chunk numbers of each wave, for compact structural assertions. */
function numbers(waves: ChunkWave[]): number[][] {
  return waves.map((w) => w.chunks.map((c) => c.number));
}

describe("conflict-graph planWaves — footprint disjointness", () => {
  it("puts two disjoint non-empty footprints (no deps) in the SAME wave", () => {
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/b.ts"] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1, 2]]);
    expect(waves[0].degraded).toBeUndefined();
  });

  it("serializes OVERLAPPING footprints into different waves, earlier-numbered first", () => {
    const chunks = [
      mk(1, { footprint: ["src/shared.ts"] }),
      mk(2, { footprint: ["src/shared.ts"] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1], [2]]);
  });

  it("treats a directory as containing files beneath it (segment-prefix conflict)", () => {
    const chunks = [
      mk(1, { footprint: ["src/db"] }),
      mk(2, { footprint: ["src/db/schema.ts"] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1], [2]]);
  });

  it("does NOT treat a name-prefix that is not a path segment as a conflict", () => {
    // `src/db` must not swallow `src/dbutil.ts` — the boundary is a slash.
    const chunks = [
      mk(1, { footprint: ["src/db"] }),
      mk(2, { footprint: ["src/dbutil.ts"] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1, 2]]);
  });

  it("normalizes paths (./ prefix, backslashes, trailing slash) before comparing", () => {
    const chunks = [
      mk(1, { footprint: ["./src/x.ts"] }),
      mk(2, { footprint: ["src\\x.ts"] }),
    ];
    const waves = planWaves(chunks);
    // Both normalize to src/x.ts → conflict → serialized.
    expect(numbers(waves)).toEqual([[1], [2]]);
  });

  it("case-folds paths so the SAME file in different case conflicts (case-insensitive FS)", () => {
    // On macOS/Windows `SRC/DB/x.ts` and `src/db/x.ts` are one file; they must
    // NOT be parallelized (would corrupt on merge).
    const chunks = [
      mk(1, { footprint: ["src/db/x.ts"] }),
      mk(2, { footprint: ["SRC/DB/x.ts"] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1], [2]]);
  });
});

describe("conflict-graph planWaves — conservative undeclared footprints", () => {
  it("puts an undefined-footprint chunk and an empty-footprint chunk each ALONE, never sharing", () => {
    const chunks = [
      mk(1, { footprint: undefined }),
      mk(2, { footprint: [] }),
    ];
    const waves = planWaves(chunks);
    expect(numbers(waves)).toEqual([[1], [2]]);
    expect(waves.every((w) => w.chunks.length === 1)).toBe(true);
  });

  it("never lets an undeclared chunk join a declared chunk's wave", () => {
    // Even with disjoint declared neighbours, the undeclared chunk stays alone.
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: undefined }),
      mk(3, { footprint: ["src/c.ts"] }),
    ];
    const waves = planWaves(chunks);
    // 1 and 3 are disjoint and both declared → they share; 2 is alone.
    expect(numbers(waves)).toEqual([[1, 3], [2]]);
  });
});

describe("conflict-graph planWaves — dependency ordering", () => {
  it("places a dependency in a STRICTLY earlier wave even when footprints are disjoint", () => {
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/b.ts"], dependsOn: [1] }),
    ];
    const waves = planWaves(chunks);
    // Disjoint footprints would allow parallelism, but dependsOn forbids it.
    expect(numbers(waves)).toEqual([[1], [2]]);
  });

  it("lets independent chunks parallelize around a dependency chain", () => {
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/b.ts"] }),
      mk(3, { footprint: ["src/c.ts"], dependsOn: [1] }),
    ];
    const waves = planWaves(chunks);
    // Wave 1: 1 & 2 (disjoint, no deps). Wave 2: 3 (waited on 1).
    expect(numbers(waves)).toEqual([[1, 2], [3]]);
  });
});

describe("conflict-graph planWaves — cycle & missing-dep safety", () => {
  it("terminates on a dependency cycle and places every chunk exactly once (degraded)", () => {
    const chunks = [
      mk(1, { footprint: ["src/a.ts"], dependsOn: [2] }),
      mk(2, { footprint: ["src/b.ts"], dependsOn: [1] }),
    ];
    const waves = planWaves(chunks);
    expect(flat(waves)).toHaveLength(2);
    expect(numbers(waves)).toEqual([[1], [2]]);
    expect(waves.every((w) => w.degraded === true)).toBe(true);
  });

  it("does not strand a chunk whose dependsOn names a missing chunk number", () => {
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/b.ts"], dependsOn: [99] }),
    ];
    const waves = planWaves(chunks);
    // 1 schedules normally; 2 can never satisfy dep 99 → flushed degraded.
    expect(flat(waves)).toHaveLength(2);
    const waveOf2 = waves.find((w) => w.chunks.some((c) => c.number === 2))!;
    expect(waveOf2.degraded).toBe(true);
    const waveOf1 = waves.find((w) => w.chunks.some((c) => c.number === 1))!;
    expect(waveOf1.degraded).toBeUndefined();
  });

  it("does not infinite-loop on a self-dependency", () => {
    const chunks = [mk(1, { footprint: ["src/a.ts"], dependsOn: [1] })];
    const waves = planWaves(chunks);
    expect(flat(waves)).toHaveLength(1);
    expect(waves[0].degraded).toBe(true);
  });
});

describe("conflict-graph planWaves — invariants", () => {
  it("places EVERY input chunk in exactly one wave — none dropped, none duplicated", () => {
    // Rich mix: parallel-safe, conflicting, dependent, undeclared, and a cycle.
    const chunks = [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/b.ts"] }),
      mk(3, { footprint: ["src/a.ts"], dependsOn: [1] }), // conflicts w/1, deps 1
      mk(4, { footprint: undefined }), // undeclared → alone
      mk(5, { footprint: ["src/e.ts"], dependsOn: [6] }), // cycle w/6
      mk(6, { footprint: ["src/f.ts"], dependsOn: [5] }), // cycle w/5
      mk(7, { footprint: [] }), // undeclared (empty) → alone
    ];
    const out = flat(planWaves(chunks));

    // Same count in and out.
    expect(out).toHaveLength(chunks.length);
    // Every original chunk object appears exactly once (identity-based).
    for (const c of chunks) {
      expect(out.filter((o) => o === c)).toHaveLength(1);
    }
    // No stray objects that were not in the input.
    for (const o of out) {
      expect(chunks).toContain(o);
    }
  });

  it("is deterministic — identical input yields identical wave structure", () => {
    const build = () => [
      mk(1, { footprint: ["src/a.ts"] }),
      mk(2, { footprint: ["src/a.ts"], dependsOn: [1] }),
      mk(3, { footprint: ["src/c.ts"] }),
      mk(4, { footprint: undefined }),
      mk(5, { footprint: ["src/e.ts"], dependsOn: [99] }),
    ];
    const first = numbers(planWaves(build()));
    const second = numbers(planWaves(build()));
    expect(second).toEqual(first);
    // And the degraded flags line up too.
    expect(planWaves(build()).map((w) => !!w.degraded)).toEqual(
      planWaves(build()).map((w) => !!w.degraded),
    );
  });
});
