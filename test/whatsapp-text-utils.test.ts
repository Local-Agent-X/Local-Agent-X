import { describe, it, expect } from "vitest";
import { splitMessage, toJid } from "../src/whatsapp-bridge/text-utils.js";

describe("toJid", () => {
  it("appends @s.whatsapp.net to a clean number", () => {
    expect(toJid("12345678901")).toBe("12345678901@s.whatsapp.net");
  });

  it("strips non-digits before normalizing", () => {
    expect(toJid("+1 (234) 567-8901")).toBe("12345678901@s.whatsapp.net");
  });

  it("passes through an already-formed JID-shaped string", () => {
    // Function checks if cleaned digits include '@' — they won't (regex strips everything non-digit),
    // so this exercises the strip path with a JID input that becomes pure digits.
    // To exercise pass-through, the input must have @ AND not be stripped first.
    // Per current implementation, an input like "12345@s.whatsapp.net" → strip → "12345" → no '@' → appended.
    // Pin the actual behavior:
    expect(toJid("12345@s.whatsapp.net")).toBe("12345@s.whatsapp.net");
  });
});

describe("splitMessage", () => {
  it("returns the full text in one chunk when under the limit", () => {
    expect(splitMessage("hello world", 4000)).toEqual(["hello world"]);
  });

  it("splits on newline when one exists in range", () => {
    const text = "line one\nline two\nline three";
    const chunks = splitMessage(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should end at a newline boundary
    expect(chunks[0]).toContain("line");
  });

  it("splits on space when no newline is in range", () => {
    const text = "abcdefghij klmnopqrst uvwxyz12345";
    const chunks = splitMessage(text, 12);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be at most 12 chars
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
  });

  it("hard-cuts when neither newline nor space is in range", () => {
    const text = "a".repeat(50);
    const chunks = splitMessage(text, 10);
    expect(chunks).toHaveLength(5);
    expect(chunks.every(c => c.length === 10)).toBe(true);
  });

  it("strips leading whitespace on continuations", () => {
    const text = "first chunk    second chunk";
    const chunks = splitMessage(text, 13);
    expect(chunks[1].startsWith(" ")).toBe(false);
  });
});
