import { describe, it, expect } from "vitest";
import { EmotionalMemory } from "./emotional-memory.js";

describe("EmotionalMemory.detectEmotion — whole-word keyword matching (AM-1)", () => {
  it("does not read 'angry' out of technical words containing 'rage'", () => {
    // 'rage' ⊂ 'storage'/'average' — a build prompt like this used to record 'angry'.
    const e = EmotionalMemory.detectEmotion(
      "Compute the average latency and flush it to storage before the next batch.",
    );
    expect(e.primary).not.toBe("angry");
    expect(e.signals).not.toContain('keyword:"rage"');
  });

  it("does not read 'frustrated' out of 'against'", () => {
    // 'again' ⊂ 'against'
    const e = EmotionalMemory.detectEmotion(
      "Validate the payload against the schema and return the diff.",
    );
    expect(e.signals).not.toContain('keyword:"again"');
    expect(e.primary).not.toBe("frustrated");
  });

  it("still detects a genuine whole-word 'angry' keyword", () => {
    const e = EmotionalMemory.detectEmotion("I am so angry, this is unacceptable and infuriating.");
    expect(e.primary).toBe("angry");
    expect(e.signals).toContain('keyword:"angry"');
  });

  it("still detects a genuine whole-word 'again' keyword", () => {
    const e = EmotionalMemory.detectEmotion("Ugh, it broke again and still won't work.");
    expect(e.primary).toBe("frustrated");
    expect(e.signals).toContain('keyword:"again"');
  });
});
