import { describe, it, expect } from "vitest";
import { splitForVoiceChunks } from "../src/bridge-voice/chunk-text.js";

describe("splitForVoiceChunks", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(splitForVoiceChunks("")).toEqual([]);
    expect(splitForVoiceChunks("   \n\n  ")).toEqual([]);
  });

  it("returns a single trimmed chunk when under maxLen", () => {
    expect(splitForVoiceChunks("  hello there  ", 100)).toEqual(["hello there"]);
  });

  it("greedy-merges short paragraphs that fit together", () => {
    const out = splitForVoiceChunks("para one\n\npara two", 100);
    expect(out).toEqual(["para one\n\npara two"]);
  });

  it("flushes to a new chunk when the next paragraph would overflow", () => {
    // each paragraph is 8 chars; maxLen 10 can't hold both (8 + 2 + 8 = 18)
    const out = splitForVoiceChunks("aaaaaaaa\n\nbbbbbbbb", 10);
    expect(out).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("sentence-splits a single paragraph longer than maxLen", () => {
    const out = splitForVoiceChunks("First sentence. Second sentence. Third one.", 20);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(20);
    // order + content preserved across the join
    expect(out.join(" ")).toContain("First sentence.");
    expect(out.join(" ")).toContain("Third one.");
  });

  it("hard-cuts a pathological single sentence with no breakpoints", () => {
    const out = splitForVoiceChunks("a".repeat(25), 10);
    expect(out).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
  });

  it("preserves order across paragraph and sentence splits", () => {
    const text = "P1.\n\n" + "long sentence one. long sentence two. long sentence three." + "\n\nP3.";
    const out = splitForVoiceChunks(text, 25);
    const joined = out.join(" ");
    expect(joined.indexOf("P1.")).toBeLessThan(joined.indexOf("sentence one"));
    expect(joined.indexOf("sentence three")).toBeLessThan(joined.indexOf("P3."));
  });
});
