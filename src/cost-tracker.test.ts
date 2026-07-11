import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
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

const { getPricing, hasExactPricing, trackUsage, getBillableCostSince, getModelBreakdown, getBillableCostForModelSince } = await import("./cost-tracker.js");

// Each test that reads the usage log starts from a clean slate so time-filtered
// queries don't pick up records written by earlier tests in this file.
beforeEach(() => {
  const f = join(tmp, "usage-log.json");
  if (existsSync(f)) unlinkSync(f);
});

describe("getPricing — real rates", () => {
  it("prices grok-4.3 at its real $1.25/$2.50, not the grok-4 fuzzy default", () => {
    expect(getPricing("grok-4.3")).toEqual({ input: 1.25, output: 2.50 });
  });

  it("keeps the verified flagship rates", () => {
    expect(getPricing("claude-opus-4-8")).toEqual({ input: 5, output: 25 });
    expect(getPricing("gpt-5.4")).toEqual({ input: 2.50, output: 15 });
    expect(getPricing("gemini-3-pro-preview")).toEqual({ input: 2, output: 12 });
  });

  it("prices the gpt-5.6 tiers at their per-tier rates, not a family default", () => {
    expect(getPricing("gpt-5.6-sol")).toEqual({ input: 5, output: 30 });
    expect(getPricing("gpt-5.6-terra")).toEqual({ input: 2.50, output: 15 });
    expect(getPricing("gpt-5.6-luna")).toEqual({ input: 1, output: 6 });
    expect(getPricing("gpt-5.6")).toEqual({ input: 5, output: 30 });
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

describe("getBillableCostSince — dashboard split", () => {
  it("separates real API-key spend from subscription shadow cost", () => {
    const sessionId = "billable-split";
    // grok-4.3 @ $1.25/$2.50 → 1M input = $1.25 each.
    trackUsage(sessionId, "grok-4.3", "xai", 1_000_000, 0, undefined, "env");    // billable
    trackUsage(sessionId, "grok-4.3", "xai", 1_000_000, 0, undefined, "oauth");  // shadow
    const split = getBillableCostSince(Date.now() - 60_000);
    expect(split.costUsd).toBeCloseTo(1.25, 2);   // only the api-key record bills
    expect(split.shadowUsd).toBeCloseTo(1.25, 2); // subscription record is shadow
  });
});

describe("getModelBreakdown — per-model, with provider + billable flag", () => {
  it("tags an API-key model billable and a local model not, and counts local tokens", () => {
    trackUsage("s", "grok-4.3", "xai", 1000, 50, undefined, "env");       // api-key
    trackUsage("s", "qwen2:7b", "local", 2000, 800, undefined, "sentinel"); // local, free
    const bm = getModelBreakdown(Date.now() - 60_000);
    expect(bm["grok-4.3"].billable).toBe(true);
    expect(bm["grok-4.3"].provider).toBe("xai");
    expect(bm["qwen2:7b"].billable).toBe(false);  // local → never cappable
    expect(bm["qwen2:7b"].provider).toBe("local");
    expect(bm["qwen2:7b"].input).toBe(2000);      // local token counts ARE tracked
    expect(bm["qwen2:7b"].output).toBe(800);
    expect(bm["qwen2:7b"].cost).toBe(0);          // local pricing is free
  });
});

describe("getBillableCostForModelSince — per-model cap input", () => {
  it("sums only the named model's real (API-key) spend", () => {
    trackUsage("s", "grok-4.3", "xai", 1_000_000, 0, undefined, "env");   // $1.25 billable
    trackUsage("s", "grok-4.3", "xai", 1_000_000, 0, undefined, "oauth"); // shadow — excluded
    trackUsage("s", "claude-opus-4-8", "anthropic", 1_000_000, 0, undefined, "env"); // other model
    expect(getBillableCostForModelSince("grok-4.3", Date.now() - 60_000)).toBeCloseTo(1.25, 2);
  });
});
