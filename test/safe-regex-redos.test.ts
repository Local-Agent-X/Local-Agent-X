import { describe, it, expect } from "vitest";
import { checkRegexSafety, safeRegex } from "../src/safe-regex.js";

describe("checkRegexSafety — known-safe patterns pass", () => {
  it("returns null for a plain literal", () => {
    expect(checkRegexSafety("abc")).toBeNull();
  });

  it("returns null for an anchored wildcard pattern", () => {
    expect(checkRegexSafety("^foo.*bar$")).toBeNull();
  });

  it("returns null for a typical character-class / counted pattern", () => {
    expect(checkRegexSafety("\\d{3}-\\d{4}")).toBeNull();
  });

  it("returns null for non-overlapping alternation under a quantifier", () => {
    expect(checkRegexSafety("(a|b)+")).toBeNull();
    expect(checkRegexSafety("(ab|cd)*")).toBeNull();
  });

  it("returns null for a long-but-under-limit pattern (500 chars exactly)", () => {
    expect(checkRegexSafety("a".repeat(500))).toBeNull();
  });
});

describe("checkRegexSafety — classic ReDoS shapes are flagged unsafe", () => {
  it("flags nested quantifiers (a+)+", () => {
    const r = checkRegexSafety("(a+)+");
    expect(r).not.toBeNull();
    expect(r).toMatch(/nested quantifier/i);
  });

  it("flags nested quantifiers (a*)* and (a+)*", () => {
    expect(checkRegexSafety("(a*)*")).toMatch(/nested quantifier/i);
    expect(checkRegexSafety("(a+)*")).toMatch(/nested quantifier/i);
  });

  it("flags wrapping-group nested quantifier (.*)*", () => {
    expect(checkRegexSafety("(.*)*")).toMatch(/nested quantifier/i);
  });

  it("flags overlapping alternation (a|a)* and (a|a)+", () => {
    expect(checkRegexSafety("(a|a)*")).toMatch(/overlapping alternation/i);
    expect(checkRegexSafety("(a|a)+")).toMatch(/overlapping alternation/i);
  });

  it("flags optional-overlap alternation (a|a?)+", () => {
    const r = checkRegexSafety("(a|a?)+");
    expect(r).not.toBeNull();
    expect(r).toMatch(/overlapping alternation/i);
  });

  it("flags adjacent quantified wildcards .*.*", () => {
    expect(checkRegexSafety(".*.*")).toMatch(/adjacent wildcard/i);
  });

  it("flags patterns longer than 500 characters", () => {
    const r = checkRegexSafety("a".repeat(501));
    expect(r).not.toBeNull();
    expect(r).toMatch(/exceeds 500 characters/i);
  });
});

describe("safeRegex — throws on flagged patterns, compiles safe ones", () => {
  it("throws for a nested-quantifier pattern", () => {
    expect(() => safeRegex("(a+)+")).toThrow(/Unsafe regex pattern/i);
  });

  it("compiles a safe pattern into a usable RegExp", () => {
    const re = safeRegex("^foo.*bar$");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test("FOOxbar")).toBe(true); // default flag is "i"
  });
});

/**
 * BUG REGRESSION LOCK — see bug_found.
 *
 * The overlapping-alternation and nested-quantifier heuristics only look for a
 * trailing `+` or `*` after the group ( /...\)[+*]/ ). They do NOT recognize the
 * counted-quantifier forms `{n}` / `{n,}` / `{n,m}`, which are equally capable of
 * driving catastrophic backtracking. So classic ReDoS shapes that use a counted
 * quantifier slip through checkRegexSafety as "safe".
 *
 * These tests PIN the current (buggy) behavior so the gap is visible and any future
 * fix will intentionally break them. They assert the present return value, NOT the
 * desired one.
 */
describe("checkRegexSafety — counted-quantifier ReDoS shapes (CURRENT buggy behavior pinned)", () => {
  it("does NOT flag (a+){2,} (nested quantifier via counted form) — bug", () => {
    expect(checkRegexSafety("(a+){2,}")).toBeNull();
  });

  it("does NOT flag (a|a){2,} (overlapping alternation via counted form) — bug", () => {
    expect(checkRegexSafety("(a|a){2,}")).toBeNull();
  });

  it("does NOT flag (a|a){10} (overlapping alternation, fixed count) — bug", () => {
    expect(checkRegexSafety("(a|a){10}")).toBeNull();
  });

  it("safeRegex compiles the counted-form ReDoS pattern instead of throwing — bug", () => {
    expect(() => safeRegex("(a+){2,}")).not.toThrow();
    expect(safeRegex("(a+){2,}")).toBeInstanceOf(RegExp);
  });
});
