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

  it("returns null for adjacent quantifiers over DISJOINT enumerable characters", () => {
    // a* and b* can't split a shared priming run — linear, not catastrophic.
    expect(checkRegexSafety("a*b*")).toBeNull();
    expect(checkRegexSafety("[a-c]*[x-z]*")).toBeNull();
  });

  it("returns null for a single .* between literals (.*foo.*)", () => {
    // The literal `foo` separates the two `.*`, so they are not adjacent.
    expect(checkRegexSafety(".*foo.*")).toBeNull();
  });

  it("returns null for adjacent BOUNDED quantifiers (\\d{3}\\d{3})", () => {
    expect(checkRegexSafety("\\d{3}\\d{3}")).toBeNull();
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

  it("flags adjacent quantified wildcards .*.* and .+.+", () => {
    // .+.+ is the case the old `/\.+\.+/` guard silently missed (that regex
    // matched runs of dots, never the string `.+.+`).
    expect(checkRegexSafety(".*.*")).toMatch(/adjacent unbounded quantifiers/i);
    expect(checkRegexSafety(".+.+")).toMatch(/adjacent unbounded quantifiers/i);
  });

  it("flags the sequential-sibling family a*a*…b (kernel-freeze repro)", () => {
    // Measured ~32s on `'a'.repeat(30)` before the fix — polynomial blowup from
    // ten adjacent quantified atoms over the same character.
    expect(checkRegexSafety("a*a*a*a*a*a*a*a*a*a*b")).toMatch(
      /adjacent unbounded quantifiers/i,
    );
    expect(checkRegexSafety("a*a*b")).toMatch(/adjacent unbounded quantifiers/i);
  });

  it("flags adjacent shorthand/class repeats \\d*\\d*x and [0-9]*[0-9]*X", () => {
    expect(checkRegexSafety("\\d*\\d*x")).toMatch(
      /adjacent unbounded quantifiers/i,
    );
    expect(checkRegexSafety("[0-9]*[0-9]*X")).toMatch(
      /adjacent unbounded quantifiers/i,
    );
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
