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
 * Counted-quantifier ReDoS shapes. The nested-quantifier and overlapping-
 * alternation heuristics recognize the counted forms `{n}` / `{n,}` / `{n,m}`,
 * not just `+`/`*` — they drive catastrophic backtracking just the same.
 */
describe("checkRegexSafety — counted-quantifier ReDoS shapes are flagged unsafe", () => {
  it("flags (a+){2,} (nested quantifier via counted form)", () => {
    expect(checkRegexSafety("(a+){2,}")).not.toBeNull();
  });

  it("flags (a|a){2,} (overlapping alternation via counted form)", () => {
    expect(checkRegexSafety("(a|a){2,}")).not.toBeNull();
  });

  it("flags (a|a){10} (overlapping alternation, fixed count)", () => {
    expect(checkRegexSafety("(a|a){10}")).not.toBeNull();
  });

  it("safeRegex throws on the counted-form ReDoS pattern", () => {
    expect(() => safeRegex("(a+){2,}")).toThrow();
  });
});
