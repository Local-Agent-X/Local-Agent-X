import { describe, it, expect } from "vitest";
import { BITRATE_TIERS_KBPS, BitrateLadder } from "./bitrate-ladder.js";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("BitrateLadder", () => {
  it("starts at the top tier and holds on a clean path", () => {
    const c = clock();
    const ladder = new BitrateLadder(c.now);
    expect(ladder.kbps).toBe(BITRATE_TIERS_KBPS[0]);
    for (let i = 0; i < 5; i += 1) {
      c.advance(1000);
      expect(ladder.report({ fractionLost: 0, rttMs: 60 })).toBeNull();
    }
  });

  it("steps down on heavy loss, but not again within the hold", () => {
    const c = clock();
    const ladder = new BitrateLadder(c.now);
    c.advance(5000);
    expect(ladder.report({ fractionLost: 0.2 })).toBe(BITRATE_TIERS_KBPS[1]);
    c.advance(1000);
    expect(ladder.report({ fractionLost: 0.3 })).toBeNull(); // the new encoder hasn't had a chance yet
    c.advance(4000);
    expect(ladder.report({ fractionLost: 0.3 })).toBe(BITRATE_TIERS_KBPS[2]);
  });

  it("needs two strained reports in a row for moderate loss or a slow round trip", () => {
    const c = clock();
    const ladder = new BitrateLadder(c.now);
    c.advance(5000);
    expect(ladder.report({ fractionLost: 0.05 })).toBeNull();
    c.advance(1000);
    expect(ladder.report({ fractionLost: 0, rttMs: 450 })).toBe(BITRATE_TIERS_KBPS[1]);
    c.advance(5000);
    expect(ladder.report({ fractionLost: 0, rttMs: 500 })).toBeNull(); // the streak restarted with the step
  });

  it("climbs one tier after a clean stretch, and never above the top", () => {
    const c = clock();
    const ladder = new BitrateLadder(c.now);
    c.advance(5000);
    ladder.report({ fractionLost: 0.5 });
    // Clean is timed from the first clean report after the step (t+1s), so ten
    // seconds of it end at the eleventh.
    for (let i = 0; i < 10; i += 1) {
      c.advance(1000);
      expect(ladder.report({ fractionLost: 0, rttMs: 80 })).toBeNull();
    }
    c.advance(1000);
    expect(ladder.report({ fractionLost: 0, rttMs: 80 })).toBe(BITRATE_TIERS_KBPS[0]);
    c.advance(20_000);
    expect(ladder.report({ fractionLost: 0, rttMs: 80 })).toBeNull();
  });

  it("stops at the bottom tier", () => {
    const c = clock();
    const ladder = new BitrateLadder(c.now);
    for (let i = 0; i < 10; i += 1) {
      c.advance(5000);
      ladder.report({ fractionLost: 0.5 });
    }
    expect(ladder.kbps).toBe(BITRATE_TIERS_KBPS[BITRATE_TIERS_KBPS.length - 1]);
  });
});
