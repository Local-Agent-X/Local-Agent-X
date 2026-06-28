import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// cost-tracker binds USAGE_FILE = join(getLaxDir(), …) at import, so isolate the
// data dir BEFORE the dynamic import below (top-level await runs at file eval).
const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-cost-tracker-"));
process.env.LAX_DATA_DIR = tmp;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(tmp, { recursive: true, force: true });
});

const { getPricing, hasExactPricing, trackUsage } = await import("./cost-tracker.js");

describe("getPricing — real rates", () => {
  it("prices grok-4.3 at its real $1.25/$2.50, not the grok-4 fuzzy default", () => {
    expect(getPricing("grok-4.3")).toEqual({ input: 1.25, output: 2.50 });
  });

  it("keeps the verified flagship rates", () => {
    expect(getPricing("claude-opus-4-8")).toEqual({ input: 5, output: 25 });
    expect(getPricing("gpt-5.4")).toEqual({ input: 2.50, output: 15 });
    expect(getPricing("gemini-3-pro-preview")).toEqual({ input: 2, output: 12 });
  });

  it("still prefix-matches alias suffixes to their base model", () => {
    expect(getPricing("claude-opus-4-8[1m]")).toEqual({ input: 5, output: 25 });
  });

  it("falls back to the mid-road default for a truly unknown model", () => {
    expect(getPricing("totally-unknown-model-xyz")).toEqual({ input: 3, output: 15 });
  });
});

describe("hasExactPricing — what the coverage gate checks", () => {
  it("is true only for an exact table entry, not a prefix or fallback", () => {
    expect(hasExactPricing("grok-4.3")).toBe(true);
    expect(hasExactPricing("claude-opus-4-8")).toBe(true);
    expect(hasExactPricing("claude-opus-4-8[1m]")).toBe(false); // prefix, not exact
    expect(hasExactPricing("totally-unknown-model-xyz")).toBe(false);
  });
});

describe("trackUsage — loud fallback + correct cost", () => {
  it("computes grok-4.3 cost at the real rate (the 'hi' was ~5¢, not 13¢)", () => {
    const r = trackUsage("s1", "grok-4.3", "xai", 42388, 6, undefined, "oauth");
    expect(r.costUsd).toBeCloseTo(0.053, 3);
    expect(r.pricingEstimated).toBeUndefined();
  });

  it("flags a record as estimated when the model has no price entry", () => {
    const r = trackUsage("s1", "some-new-unpriced-model", "xai", 1000, 1000);
    expect(r.pricingEstimated).toBe(true);
  });
});
