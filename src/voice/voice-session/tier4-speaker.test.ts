// The in-process speaker hands the engine whole sentences: each chunk is said like a
// sentence of its own, so a cut at a comma sounds like a machine reading fragments.
import { describe, expect, it } from "vitest";
import { createTier4Speaker } from "./tier4-speaker.js";

function speaker() {
  const spoken: string[] = [];
  const s = createTier4Speaker(() => ({ speak: (text: string) => { spoken.push(text); } }));
  return { s, spoken };
}

describe("tier4 speaker", () => {
  it("speaks a long sentence with commas in one piece", () => {
    const { s, spoken } = speaker();
    s.feed("Yeah, it's a quick way to find out. ");
    s.feed("A legit company has that report ready, and if they stall or dodge it, you know.");
    s.flushTail();
    expect(spoken).toEqual([
      "Yeah, it's a quick way to find out.",
      "A legit company has that report ready, and if they stall or dodge it, you know.",
    ]);
  });

  it("starts a long opening sentence early, at a clause break, then speaks the rest whole", () => {
    const { s, spoken } = speaker();
    s.feed("Okay, I checked the photo, and there's no lot number printed on the strips");
    s.feed(" anywhere I could see. Flip one over, and look at the back.");
    s.flushTail();
    expect(spoken).toEqual([
      "Okay, I checked the photo,",
      "and there's no lot number printed on the strips anywhere I could see.",
      "Flip one over, and look at the back.",
    ]);
  });
});
