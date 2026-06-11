/**
 * Exclusive-slot value-change detection: "X works at Google" superseded by
 * "X works at Microsoft" with no negation anywhere. The polarity rule can't
 * see these (same polarity on both sides); the slot rule must — without
 * firing on accumulative statements ("likes coffee" then "likes tea") or
 * across tense ("worked at" is history, compatible with a new employer).
 */
import { describe, it, expect } from "vitest";
import { findContradictions } from "./contradiction-sweep.js";

describe("findContradictions — exclusive-slot value changes", () => {
  it("supersedes the older value of an exclusive slot (newer wins)", () => {
    const pairs = findContradictions([
      { text: "works at Google", payload: "old", subjectHint: "alex" },
      { text: "works at Microsoft", payload: "new", subjectHint: "alex" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep).toBe("new");
    expect(pairs[0].drop).toBe("old");
  });

  it("uses the explicit subject in the text when present", () => {
    const pairs = findContradictions([
      { text: "Alex lives in Portland", payload: "old" },
      { text: "Alex lives in Austin", payload: "new" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep).toBe("new");
  });

  it("does not fire across different subjects", () => {
    const pairs = findContradictions([
      { text: "works at Initech", payload: "a", subjectHint: "alex" },
      { text: "works at Microsoft", payload: "b", subjectHint: "ben" },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("does not fire on accumulative predicates (likes coffee / likes tea)", () => {
    const pairs = findContradictions([
      { text: "likes morning coffee", payload: "a", subjectHint: "alex" },
      { text: "likes evening tea", payload: "b", subjectHint: "alex" },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("does not fire across tense — past employment coexists with present", () => {
    const pairs = findContradictions([
      { text: "worked at Google", payload: "a", subjectHint: "alex" },
      { text: "works at Microsoft", payload: "b", subjectHint: "alex" },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("does not fire when the slot value is unchanged", () => {
    const pairs = findContradictions([
      { text: "works at Google", payload: "a", subjectHint: "alex" },
      { text: "currently works at Google", payload: "b", subjectHint: "alex" },
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("keeps the polarity rule intact (negation wins regardless of order)", () => {
    const pairs = findContradictions([
      { text: "no Spanish greetings", payload: "negation" },
      { text: "always greet in Spanish", payload: "affirm" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].keep).toBe("negation");
    expect(pairs[0].drop).toBe("affirm");
  });
});
