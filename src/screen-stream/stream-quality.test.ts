import { describe, it, expect } from "vitest";
import { BITRATE_TIERS_KBPS } from "./bitrate-ladder.js";
import { StreamQuality } from "./stream-quality.js";

function setup() {
  let t = 0;
  const restarts: number[] = [];
  const quality = new StreamQuality((kbps) => restarts.push(kbps), () => t);
  return { quality, restarts, advance: (ms: number) => (t += ms) };
}

describe("StreamQuality", () => {
  it("restarts capture at the lower tier when the phone reports heavy loss", () => {
    const { quality, restarts, advance } = setup();
    advance(5000);
    quality.report({ fractionLost: 0.25, rttMs: 120 });
    expect(restarts).toEqual([BITRATE_TIERS_KBPS[1]]);
    expect(quality.bitrateKbps).toBe(BITRATE_TIERS_KBPS[1]);
  });

  it("does nothing on a clean report", () => {
    const { quality, restarts, advance } = setup();
    advance(5000);
    quality.report({ fractionLost: 0, rttMs: 40 });
    expect(restarts).toEqual([]);
  });

  it("answers a keyframe request with a restart at the current bitrate, at most every 3 s", () => {
    const { quality, restarts, advance } = setup();
    quality.keyframeRequested();
    quality.keyframeRequested();
    advance(1000);
    quality.keyframeRequested();
    advance(2500);
    quality.keyframeRequested();
    expect(restarts).toEqual([BITRATE_TIERS_KBPS[0], BITRATE_TIERS_KBPS[0]]);
  });

  it("a bitrate step counts as the keyframe (no second restart right after)", () => {
    const { quality, restarts, advance } = setup();
    advance(5000);
    quality.report({ fractionLost: 0.5 });
    quality.keyframeRequested();
    expect(restarts).toEqual([BITRATE_TIERS_KBPS[1]]);
  });
});
