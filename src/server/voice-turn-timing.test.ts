import { describe, expect, it } from "vitest";
import { createVoiceTurnClock } from "./voice-turn-timing.js";

function fakeClock(...times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe("voice turn timing", () => {
  it("splits the wait before the first word into steps that add up to the whole", () => {
    // start 0, slot 10, load 30, prepare 2030, plan 2100, first token 3100
    const clock = createVoiceTurnClock(fakeClock(0, 10, 30, 2030, 2100, 3100));
    clock.mark("slot");
    clock.mark("load");
    clock.mark("prepare");
    clock.mark("plan");
    clock.firstToken();
    expect(clock.line("voice-1", "anthropic/claude-haiku-4-5")).toBe(
      "[timing] voice-turn voice-1 (anthropic/claude-haiku-4-5) slot=10ms load=20ms prepare=2000ms plan=70ms model=1000ms",
    );
  });

  it("counts only the first token, and marks steps the turn never reached", () => {
    const clock = createVoiceTurnClock(fakeClock(0, 5, 50, 900));
    clock.mark("slot");
    clock.firstToken();
    clock.firstToken();
    expect(clock.line("s", "m")).toBe("[timing] voice-turn s (m) slot=5ms load=- prepare=- plan=- model=45ms");
  });
});
