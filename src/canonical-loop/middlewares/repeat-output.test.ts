import { describe, it, expect } from "vitest";
import { repeatOutputMiddleware, normalizeForRepeat, outputsSimilar } from "./repeat-output.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-repeat-out-${++_op}`; }

function ctxFor(op: string, text: string): CanonicalLoopContext {
  return { op: { id: op }, assistantContent: text } as unknown as CanonicalLoopContext;
}
const run = (op: string, text: string) => repeatOutputMiddleware.afterModelCall!(ctxFor(op, text));

// Two clearly-different substantive replies (>= MIN_TOKENS, near-disjoint tokens).
const A = "The build passed and all seventeen integration tests are green.";
const B = "Weather over the pacific ocean shifts during autumn monsoon season heavily.";
const SHORT = "ok done thanks";

describe("normalizeForRepeat", () => {
  it("lowercases and strips to alphanumeric tokens", () => {
    expect(normalizeForRepeat("Hello, World!! foo-bar")).toEqual(["hello", "world", "foo", "bar"]);
  });
  it("returns [] for empty / whitespace / punctuation-only", () => {
    expect(normalizeForRepeat("")).toEqual([]);
    expect(normalizeForRepeat("   ")).toEqual([]);
    expect(normalizeForRepeat("!!! ??? ---")).toEqual([]);
  });
});

describe("outputsSimilar (token-set Jaccard ≥ 0.9)", () => {
  const toks = (n: number, extra: string[] = []) =>
    [...Array.from({ length: n }, (_, i) => `t${i}`), ...extra];

  it("true for identical, false for disjoint or empty", () => {
    expect(outputsSimilar(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
    expect(outputsSimilar(["a", "b"], ["x", "y"])).toBe(false);
    expect(outputsSimilar([], ["a"])).toBe(false);
    expect(outputsSimilar(["a"], [])).toBe(false);
  });

  it("respects the 0.9 threshold at the boundary", () => {
    // 19 shared of 21 union = 0.905 → similar
    expect(outputsSimilar(toks(20), [...toks(19), "x"])).toBe(true);
    // 18 shared of 22 union = 0.818 → not similar
    expect(outputsSimilar(toks(20), [...toks(18), "x", "y"])).toBe(false);
  });
});

describe("repeatOutputMiddleware", () => {
  it("nudges on the 3rd identical reply and ABORTS on the 5th", () => {
    const op = opId();
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 1
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 2
    expect(run(op, A)).toMatchObject({ kind: "nudge", reason: "repeat-output" }); // 3
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 4 (already nudged)
    expect(run(op, A)).toMatchObject({ kind: "abort", reason: "repeat-output" }); // 5
  });

  it("resets on a genuinely different reply, preventing the abort", () => {
    const op = opId();
    run(op, A); run(op, A); run(op, A); run(op, A);                   // repeats climbing, nudged
    expect(run(op, B)).toEqual({ kind: "continue" });                 // divergence → reset, NO abort
    expect(run(op, A)).toEqual({ kind: "continue" });                 // streak restarts from scratch
  });

  it("ignores short outputs entirely (a repeated 'ok' is not a runaway)", () => {
    const op = opId();
    for (let i = 0; i < 8; i++) expect(run(op, SHORT)).toEqual({ kind: "continue" });
  });

  it("catches short-period A,B,A,B alternation via the ring buffer", () => {
    const op = opId();
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 1
    expect(run(op, B)).toEqual({ kind: "continue" });                 // 2
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 3 repeats=1
    expect(run(op, B)).toMatchObject({ kind: "nudge" });              // 4 repeats=2
    expect(run(op, A)).toEqual({ kind: "continue" });                 // 5 repeats=3
    expect(run(op, B)).toMatchObject({ kind: "abort" });              // 6 repeats=4
  });

  it("nudges at most once (nudge fires on one strike, not every turn)", () => {
    const op = opId();
    run(op, A); run(op, A);
    expect(run(op, A)).toMatchObject({ kind: "nudge" }); // 3rd
    // 4th is a continue, not a second nudge
    expect(run(op, A)).toEqual({ kind: "continue" });
  });
});
