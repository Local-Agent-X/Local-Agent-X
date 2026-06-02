/**
 * Regression suite for cost-tracker's trackUsage + getUsageSummary.
 *
 * Focus:
 *   - accumulation across multiple calls sums correctly (no float drift on
 *     typical token counts)
 *   - per-model and per-session breakdown
 *   - `since` window filtering (getUsageSummary filter + getTodayCost)
 *   - cost math via getPricing
 *
 * Storage is a JSON file under getLaxDir(); cost-tracker resolves USAGE_FILE
 * at MODULE LOAD time, so we point LAX_DATA_DIR at a fresh temp dir and
 * vi.resetModules() + dynamic-import in each test to rebind the path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "cost-tracker-usage-"));
  process.env.LAX_DATA_DIR = dataDir;
  vi.resetModules(); // rebind USAGE_FILE to the fresh temp dir on next import
});

afterEach(() => {
  vi.useRealTimers();
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function load() {
  return import("../src/cost-tracker.js");
}

describe("cost-tracker: getPricing", () => {
  it("returns exact pricing for a known model", async () => {
    const { getPricing } = await load();
    expect(getPricing("claude-opus-4-8")).toEqual({ input: 5, output: 25 });
    expect(getPricing("gpt-4o-mini")).toEqual({ input: 0.15, output: 0.6 });
  });

  it("fuzzy-matches a known prefix", async () => {
    const { getPricing } = await load();
    // "claude-opus-4-8-20260101" starts with "claude-opus-4-8"
    expect(getPricing("claude-opus-4-8-20260101")).toEqual({ input: 5, output: 25 });
  });

  it("falls back to mid-road pricing for an unknown model", async () => {
    const { getPricing } = await load();
    expect(getPricing("totally-unknown-model")).toEqual({ input: 3, output: 15 });
  });
});

describe("cost-tracker: trackUsage cost math", () => {
  it("computes cost = (in*inputPrice + out*outputPrice)/1e6, rounded to 6dp", async () => {
    const { trackUsage } = await load();
    // claude-opus-4-8: input 5, output 25 per 1M
    const rec = trackUsage("s1", "claude-opus-4-8", "anthropic", 1_000_000, 1_000_000);
    // 1M*5/1e6 + 1M*25/1e6 = 5 + 25 = 30
    expect(rec.costUsd).toBe(30);
    expect(rec.inputTokens).toBe(1_000_000);
    expect(rec.outputTokens).toBe(1_000_000);
    expect(rec.model).toBe("claude-opus-4-8");
    expect(rec.provider).toBe("anthropic");
    expect(rec.sessionId).toBe("s1");
  });

  it("free (local) models cost zero", async () => {
    const { trackUsage } = await load();
    const rec = trackUsage("s1", "llama", "local", 500_000, 500_000);
    expect(rec.costUsd).toBe(0);
  });

  it("rounds per-record cost to 6 decimal places", async () => {
    const { trackUsage } = await load();
    // gpt-4o-mini: input 0.15/1M. 123 input tokens -> 0.15*123/1e6 = 0.00001845
    const rec = trackUsage("s1", "gpt-4o-mini", "openai", 123, 0);
    expect(rec.costUsd).toBe(0.000018); // 0.00001845 rounded to 6dp
  });
});

describe("cost-tracker: getUsageSummary accumulation", () => {
  it("sums tokens and record count across multiple calls", async () => {
    const { trackUsage, getUsageSummary } = await load();
    trackUsage("s1", "claude-opus-4-8", "anthropic", 100, 50);
    trackUsage("s1", "claude-opus-4-8", "anthropic", 200, 75);
    trackUsage("s2", "gpt-4o", "openai", 300, 25);

    const sum = getUsageSummary();
    expect(sum.recordCount).toBe(3);
    expect(sum.totalInputTokens).toBe(600);
    expect(sum.totalOutputTokens).toBe(150);
  });

  it("does not drift on typical token counts (exact dollar total)", async () => {
    const { trackUsage, getUsageSummary } = await load();
    // grok-4: input 3, output 15 per 1M. Use 1M-multiples so per-record cost
    // lands on clean values and the summed total is exact.
    trackUsage("s1", "grok-4", "xai", 1_000_000, 0); // cost 3
    trackUsage("s1", "grok-4", "xai", 1_000_000, 0); // cost 3
    trackUsage("s1", "grok-4", "xai", 0, 1_000_000); // cost 15
    const sum = getUsageSummary();
    expect(sum.totalCostUsd).toBe(21); // 3 + 3 + 15
  });

  it("totalCostUsd is rounded to 2 decimal places", async () => {
    const { trackUsage, getUsageSummary } = await load();
    // gpt-4o-mini input 0.15/1M: 1000 tokens -> 0.00015 per record.
    // Three records -> 0.00045 which rounds to 0.00 at 2dp.
    trackUsage("s1", "gpt-4o-mini", "openai", 1000, 0);
    trackUsage("s1", "gpt-4o-mini", "openai", 1000, 0);
    trackUsage("s1", "gpt-4o-mini", "openai", 1000, 0);
    const sum = getUsageSummary();
    expect(sum.totalCostUsd).toBe(0); // sub-cent total rounds to 0.00
  });

  it("breaks usage down per model", async () => {
    const { trackUsage, getUsageSummary } = await load();
    trackUsage("s1", "claude-opus-4-8", "anthropic", 100, 50);
    trackUsage("s2", "claude-opus-4-8", "anthropic", 100, 50);
    trackUsage("s1", "gpt-4o", "openai", 400, 200);

    const sum = getUsageSummary();
    expect(Object.keys(sum.byModel).sort()).toEqual(["claude-opus-4-8", "gpt-4o"]);
    expect(sum.byModel["claude-opus-4-8"].input).toBe(200);
    expect(sum.byModel["claude-opus-4-8"].output).toBe(100);
    expect(sum.byModel["gpt-4o"].input).toBe(400);
    expect(sum.byModel["gpt-4o"].output).toBe(200);
  });

  it("breaks usage down per session", async () => {
    const { trackUsage, getUsageSummary } = await load();
    trackUsage("s1", "gpt-4o", "openai", 100, 10);
    trackUsage("s1", "gpt-4o", "openai", 100, 10);
    trackUsage("s2", "gpt-4o", "openai", 50, 5);

    const sum = getUsageSummary();
    expect(sum.bySession["s1"].input).toBe(200);
    expect(sum.bySession["s1"].output).toBe(20);
    expect(sum.bySession["s2"].input).toBe(50);
    expect(sum.bySession["s2"].output).toBe(5);
  });

  it("starts empty when no records exist", async () => {
    const { getUsageSummary } = await load();
    const sum = getUsageSummary();
    expect(sum.recordCount).toBe(0);
    expect(sum.totalInputTokens).toBe(0);
    expect(sum.totalOutputTokens).toBe(0);
    expect(sum.totalCostUsd).toBe(0);
    expect(sum.byModel).toEqual({});
    expect(sum.bySession).toEqual({});
  });
});

describe("cost-tracker: filters", () => {
  it("filters by sessionId", async () => {
    const { trackUsage, getUsageSummary } = await load();
    trackUsage("s1", "gpt-4o", "openai", 100, 10);
    trackUsage("s2", "gpt-4o", "openai", 999, 99);

    const sum = getUsageSummary({ sessionId: "s1" });
    expect(sum.recordCount).toBe(1);
    expect(sum.totalInputTokens).toBe(100);
    expect(sum.bySession["s2"]).toBeUndefined();
  });

  it("filters by agentId", async () => {
    const { trackUsage, getUsageSummary } = await load();
    trackUsage("s1", "gpt-4o", "openai", 100, 10, "agentA");
    trackUsage("s1", "gpt-4o", "openai", 200, 20, "agentB");

    const sum = getUsageSummary({ agentId: "agentA" });
    expect(sum.recordCount).toBe(1);
    expect(sum.totalInputTokens).toBe(100);
  });

  it("filters by `since` window (records older than the cutoff are excluded)", async () => {
    vi.useFakeTimers();
    const { trackUsage, getUsageSummary } = await load();

    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    trackUsage("s1", "gpt-4o", "openai", 100, 10); // old

    const cutoff = new Date("2026-06-02T00:00:00.000Z").getTime();
    vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
    trackUsage("s1", "gpt-4o", "openai", 5, 1); // new

    const sum = getUsageSummary({ since: cutoff });
    expect(sum.recordCount).toBe(1);
    expect(sum.totalInputTokens).toBe(5);
    expect(sum.totalOutputTokens).toBe(1);
  });
});

describe("cost-tracker: getSessionCost / getTodayCost", () => {
  it("getSessionCost sums only the requested session", async () => {
    const { trackUsage, getSessionCost } = await load();
    trackUsage("s1", "grok-4", "xai", 1_000_000, 0); // cost 3
    trackUsage("s1", "grok-4", "xai", 1_000_000, 0); // cost 3
    trackUsage("s2", "grok-4", "xai", 1_000_000, 0); // cost 3, other session

    const c = getSessionCost("s1");
    expect(c.inputTokens).toBe(2_000_000);
    expect(c.outputTokens).toBe(0);
    expect(c.costUsd).toBe(6);
  });

  it("getTodayCost includes only records since local start-of-day", async () => {
    vi.useFakeTimers();
    const { trackUsage, getTodayCost } = await load();

    // Yesterday — must be excluded.
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    trackUsage("s1", "gpt-4o", "openai", 100, 10);

    // Today (after local midnight) — included.
    vi.setSystemTime(new Date("2026-06-02T09:30:00"));
    trackUsage("s1", "gpt-4o", "openai", 7, 3);

    const today = getTodayCost();
    expect(today.inputTokens).toBe(7);
    expect(today.outputTokens).toBe(3);
  });
});
