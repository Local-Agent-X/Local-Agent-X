import { describe, it, expect } from "vitest";
import { generateCanaries, canaryPromptBlock, checkCanaries } from "../src/threat/canaries.js";

describe("generateCanaries", () => {
  it("returns three distinct canary strings", () => {
    const c = generateCanaries();
    expect(c).toHaveLength(3);
    expect(new Set(c).size).toBe(3);
  });

  it("uses ALPHA / BRAVO / CHARLIE suffixes", () => {
    const c = generateCanaries();
    expect(c[0]).toMatch(/-ALPHA$/);
    expect(c[1]).toMatch(/-BRAVO$/);
    expect(c[2]).toMatch(/-CHARLIE$/);
  });

  it("produces a different id per call", () => {
    const a = generateCanaries();
    const b = generateCanaries();
    expect(a[0]).not.toBe(b[0]);
  });
});

describe("canaryPromptBlock", () => {
  it("embeds every canary verbatim into the block", () => {
    const c = ["CANARY-deadbeef-ALPHA", "SENTINEL-deadbeef-BRAVO"];
    const block = canaryPromptBlock(c);
    expect(block).toContain("CANARY-deadbeef-ALPHA");
    expect(block).toContain("SENTINEL-deadbeef-BRAVO");
  });
});

describe("checkCanaries", () => {
  const canaries = ["CANARY-abcd1234-ALPHA", "SENTINEL-abcd1234-BRAVO", "TRIPWIRE-abcd1234-CHARLIE"];

  it("returns null on clean output", () => {
    expect(checkCanaries("Hello, world. Nothing suspicious here.", canaries)).toBeNull();
  });

  it("detects a direct canary match", () => {
    const r = checkCanaries("Internal codes: CANARY-abcd1234-ALPHA", canaries);
    expect(r).not.toBeNull();
    expect(r).toContain("CANARY-abcd1234-ALPHA");
  });

  it("detects a case-variant canary", () => {
    const r = checkCanaries("here is canary-abcd1234-alpha leaked", canaries);
    expect(r).not.toBeNull();
    expect(r).toContain("case-variant");
  });

  it("detects fragments separated by zero-width characters", () => {
    // Insert U+200B (zero-width space) between every char of the canary
    const obfuscated = "CANARY-abcd1234-ALPHA".split("").join("​");
    const r = checkCanaries(`leak: ${obfuscated} done`, canaries);
    expect(r).not.toBeNull();
  });

  it("detects fragments split across the 200-char proximity window", () => {
    const filler = "x".repeat(50);
    const text = `prefix CANARY ${filler} abcd1234 ${filler} ALPHA tail`;
    const r = checkCanaries(text, canaries);
    expect(r).not.toBeNull();
    expect(r).toContain("fragments");
  });

  it("does not fire when fragments are farther than 200 chars apart", () => {
    const filler = "x".repeat(300);
    const text = `CANARY ${filler} abcd1234 ${filler} ALPHA`;
    expect(checkCanaries(text, canaries)).toBeNull();
  });

  it("flags any single canary leaking, even when others are clean", () => {
    const r = checkCanaries("only the second one: SENTINEL-abcd1234-BRAVO", canaries);
    expect(r).not.toBeNull();
    expect(r).toContain("SENTINEL-abcd1234-BRAVO");
  });

  it("strips line/paragraph separators before matching (regex would otherwise terminate)", () => {
    // U+2028 line separator inside the canary should not defeat detection
    const obfuscated = "CANARY-abcd1234 -ALPHA";
    const r = checkCanaries(obfuscated, canaries);
    expect(r).not.toBeNull();
  });
});
