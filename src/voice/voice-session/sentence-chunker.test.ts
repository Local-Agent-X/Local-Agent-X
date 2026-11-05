// What both speakers hand their TTS engine: whole sentences (each piece is said like a
// sentence of its own, so a comma cut sounds like a machine reading fragments), and an
// unfinished opening spoken after OPENER_WAIT_MS so the first words are never held back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentenceChunker, OPENER_WAIT_MS, openerCut } from "./sentence-chunker.js";

function chunker() {
  const spoken: string[] = [];
  return { c: createSentenceChunker((t) => spoken.push(t)), spoken };
}

afterEach(() => { vi.useRealTimers(); });

describe("sentence chunker", () => {
  it("speaks each sentence whole, commas and all", () => {
    const { c, spoken } = chunker();
    c.feed("Yeah, it's a quick way to find out. A legit company has that report ready,");
    c.feed(" and if they stall or dodge it, you know.");
    c.flushTail();
    expect(spoken).toEqual([
      "Yeah, it's a quick way to find out.",
      "A legit company has that report ready, and if they stall or dodge it, you know.",
    ]);
  });

  it("speaks an unfinished opening at its last clause break once the wait runs out", () => {
    vi.useFakeTimers();
    const { c, spoken } = chunker();
    c.feed("Okay, I checked the photo, and there's no lot");
    vi.advanceTimersByTime(OPENER_WAIT_MS - 1);
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(spoken).toEqual(["Okay, I checked the photo,"]);
    c.feed(" number on it. Flip one over, and look at the back.");
    c.flushTail();
    expect(spoken).toEqual(["Okay, I checked the photo,", "and there's no lot number on it.", "Flip one over, and look at the back."]);
  });

  it("starts a reply that pauses for a tool without waiting for the tool", () => {
    vi.useFakeTimers();
    const { c, spoken } = chunker();
    c.feed("Let me look that up");
    vi.advanceTimersByTime(OPENER_WAIT_MS);
    expect(spoken).toEqual(["Let me look that"]);
    c.flushTail();
    expect(spoken).toEqual(["Let me look that", "up"]);
  });

  it("does not cut an opening that finishes in time, and a reset drops a pending one", () => {
    vi.useFakeTimers();
    const { c, spoken } = chunker();
    c.feed("Sure, ");
    c.feed("that works.");
    vi.advanceTimersByTime(OPENER_WAIT_MS * 4);
    expect(spoken).toEqual(["Sure, that works."]);
    c.reset();
    c.feed("Interrupted before");
    c.reset();
    vi.advanceTimersByTime(OPENER_WAIT_MS * 4);
    expect(spoken).toEqual(["Sure, that works."]);
  });
});

describe("openerCut", () => {
  it("cuts after the last clause break, else the last word boundary, else nowhere", () => {
    expect(openerCut("Okay, I checked, and the")).toBe("Okay, I checked, ".length);
    expect(openerCut("I believe the answer")).toBe("I believe the ".length);
    expect(openerCut("supercalifragilistic")).toBe(-1);
  });
});
