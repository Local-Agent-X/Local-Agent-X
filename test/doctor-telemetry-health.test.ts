import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the telemetry source and the eager-tool catalog so the check is
// hermetic — no on-disk tool-stats.json, no dependence on the live catalog.
// `__stats` is mutated per-test before importing/calling the check.
type StatsEntry = {
  totalCalls: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
};
const __stats: Record<string, StatsEntry> = {};

vi.mock("../src/tool-tracker.js", () => ({
  getToolStats: vi.fn(() => __stats),
}));

// Pin a tiny, known eager set so "all exercised" is provable.
vi.mock("../src/tools/audience-map.js", () => ({
  AUDIENCES_BY_TOOL: {
    read: ["main-chat"],
    write: ["main-chat"],
    bash: ["main-chat"],
  },
}));

import { checkToolTelemetryHealth } from "../src/doctor.js";

function entry(totalCalls: number, successes: number): StatsEntry {
  return { totalCalls, successes, failures: totalCalls - successes, avgDurationMs: 1 };
}

beforeEach(() => {
  for (const k of Object.keys(__stats)) delete __stats[k];
});

describe("checkToolTelemetryHealth", () => {
  it("(a) passes quietly when telemetry is sparse (< 50 total calls)", () => {
    // Even with an unused eager tool, sparse data must NOT flag anything.
    __stats.read = entry(10, 10);
    const r = checkToolTelemetryHealth();
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/not enough usage data/i);
    expect(r.fix).toBeUndefined();
  });

  it("(b) warns and names an eager tool with 0 calls amid >=50 total calls", () => {
    __stats.read = entry(40, 40);
    __stats.write = entry(20, 20); // total = 60 >= 50
    // `bash` is eager (mocked) but has no stats entry → unused.
    const r = checkToolTelemetryHealth();
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("Consider deferring (rarely used)");
    expect(r.fix).toContain("bash");
    expect(r.fix).toContain("src/tools/audience-map.ts");
  });

  it("(c) warns and names a tool with totalCalls 10 / successes 2 as low-success", () => {
    // Exercise every eager tool so the only finding is the low-success outlier.
    __stats.read = entry(20, 20);
    __stats.write = entry(20, 20);
    __stats.bash = entry(20, 20);
    __stats.web_fetch = entry(10, 2); // 20% success, >= 5 calls
    const r = checkToolTelemetryHealth();
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("Investigate low success rate");
    expect(r.fix).toContain("web_fetch (20%)");
  });

  it("(d) passes when all eager tools exercised and no low-success outliers", () => {
    __stats.read = entry(30, 29);
    __stats.write = entry(30, 30);
    __stats.bash = entry(30, 28);
    const r = checkToolTelemetryHealth();
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/all exercised/);
    expect(r.fix).toBeUndefined();
  });

  it("does not flag a low-volume tool (totalCalls < 5) as low-success", () => {
    __stats.read = entry(30, 30);
    __stats.write = entry(30, 30);
    __stats.bash = entry(30, 30);
    __stats.flaky = entry(4, 0); // 0% but only 4 calls → ignored
    const r = checkToolTelemetryHealth();
    expect(r.status).toBe("pass");
  });
});
