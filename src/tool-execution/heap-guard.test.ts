import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  heapPressure,
  shouldRefuseToolCall,
  parseHeapGuardRatio,
  parseMaxParallelTools,
  heapGuardRatio,
  maxParallelToolBatch,
  heapRefusalMessage,
  heapRefusalResult,
  sampleHeapPressure,
  setHeapStatsForTests,
  newHeapGuardTurn,
  isHeapGuardExempt,
  HEAP_GUARD_EXEMPT_TOOLS,
  DEFAULT_HEAP_GUARD_RATIO,
  DEFAULT_MAX_PARALLEL_TOOL_BATCH,
} from "./heap-guard.js";

const GB = 1024 * 1024 * 1024;

// The env knobs are read per call, so pin/clear them explicitly here rather
// than trust whatever the runner's environment carries.
const ENV_KEYS = ["LAX_HEAP_GUARD_RATIO", "LAX_MAX_PARALLEL_TOOLS"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe("heapPressure", () => {
  it("derives MB figures and the used/limit ratio from v8 heap statistics", () => {
    // The 2026-08-30 crash shape: 3.9 GB used against a 4 GB --max-old-space-size.
    const p = heapPressure({ used_heap_size: 3.9 * GB, heap_size_limit: 4 * GB });
    expect(p.usedMb).toBe(3994);
    expect(p.limitMb).toBe(4096);
    expect(p.ratio).toBeCloseTo(0.975, 6);
  });

  it("reads the limit from heap_size_limit rather than a hardcoded 4096", () => {
    const p = heapPressure({ used_heap_size: 1 * GB, heap_size_limit: 8 * GB });
    expect(p.limitMb).toBe(8192);
    expect(p.ratio).toBeCloseTo(0.125, 6);
  });

  it("reports ratio 0 (never refuses) when the limit is unknown/zero", () => {
    expect(heapPressure({ used_heap_size: 5 * GB, heap_size_limit: 0 }).ratio).toBe(0);
  });
});

describe("shouldRefuseToolCall", () => {
  it("refuses at or above the threshold and allows below it", () => {
    expect(shouldRefuseToolCall(0.9, 0.85)).toBe(true);
    expect(shouldRefuseToolCall(0.85, 0.85)).toBe(true);
    expect(shouldRefuseToolCall(0.5, 0.85)).toBe(false);
    expect(shouldRefuseToolCall(0.8499, 0.85)).toBe(false);
  });

  it("a threshold of 0 disables the guard entirely", () => {
    expect(shouldRefuseToolCall(0.99, 0)).toBe(false);
    expect(shouldRefuseToolCall(1, 0)).toBe(false);
  });

  it("defaults the threshold to the env-derived ratio (0.85 when unset)", () => {
    expect(shouldRefuseToolCall(0.86)).toBe(true);
    expect(shouldRefuseToolCall(0.84)).toBe(false);
  });

  it("honours LAX_HEAP_GUARD_RATIO at call time — including 0 to disable", () => {
    process.env.LAX_HEAP_GUARD_RATIO = "0.6";
    expect(shouldRefuseToolCall(0.65)).toBe(true);
    process.env.LAX_HEAP_GUARD_RATIO = "0";
    expect(shouldRefuseToolCall(0.99)).toBe(false);
  });
});

describe("parseHeapGuardRatio / heapGuardRatio (LAX_HEAP_GUARD_RATIO)", () => {
  it("falls back to the default when unset, blank, or non-numeric", () => {
    expect(parseHeapGuardRatio(undefined)).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(parseHeapGuardRatio("")).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(parseHeapGuardRatio("   ")).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(parseHeapGuardRatio("abc")).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(parseHeapGuardRatio("NaN")).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(parseHeapGuardRatio("Infinity")).toBe(DEFAULT_HEAP_GUARD_RATIO);
    expect(heapGuardRatio()).toBe(DEFAULT_HEAP_GUARD_RATIO);
  });

  it("0 disables; other values clamp into [0.5, 0.99]", () => {
    expect(parseHeapGuardRatio("0")).toBe(0);
    expect(parseHeapGuardRatio("0.7")).toBe(0.7);
    expect(parseHeapGuardRatio("0.3")).toBe(0.5);
    expect(parseHeapGuardRatio("-1")).toBe(0.5);
    expect(parseHeapGuardRatio("1")).toBe(0.99);
    expect(parseHeapGuardRatio("1.5")).toBe(0.99);
  });

  it("heapGuardRatio reads the env each call", () => {
    process.env.LAX_HEAP_GUARD_RATIO = "0.75";
    expect(heapGuardRatio()).toBe(0.75);
    process.env.LAX_HEAP_GUARD_RATIO = "2";
    expect(heapGuardRatio()).toBe(0.99);
  });
});

describe("parseMaxParallelTools / maxParallelToolBatch (LAX_MAX_PARALLEL_TOOLS)", () => {
  it("defaults to 8 and accepts a positive integer override", () => {
    expect(DEFAULT_MAX_PARALLEL_TOOL_BATCH).toBe(8);
    expect(parseMaxParallelTools(undefined)).toBe(8);
    expect(parseMaxParallelTools("")).toBe(8);
    expect(parseMaxParallelTools("4")).toBe(4);
    expect(parseMaxParallelTools("1")).toBe(1);
    expect(parseMaxParallelTools("32")).toBe(32);
    expect(maxParallelToolBatch()).toBe(8);
  });

  it("rejects zero, negatives, fractions, and garbage back to the default", () => {
    expect(parseMaxParallelTools("0")).toBe(8);
    expect(parseMaxParallelTools("-3")).toBe(8);
    expect(parseMaxParallelTools("2.5")).toBe(8);
    expect(parseMaxParallelTools("eight")).toBe(8);
  });

  it("maxParallelToolBatch reads the env each call", () => {
    process.env.LAX_MAX_PARALLEL_TOOLS = "3";
    expect(maxParallelToolBatch()).toBe(3);
  });
});

describe("exempt control/terminal tools", () => {
  it("exempts exactly the named control/terminal tools", () => {
    expect([...HEAP_GUARD_EXEMPT_TOOLS].sort()).toEqual([
      "agent_escalate", "ask_user", "process_kill", "process_list", "process_status",
      "send_file", "session_status", "task_create", "task_update",
    ]);
    for (const name of HEAP_GUARD_EXEMPT_TOOLS) expect(isHeapGuardExempt(name)).toBe(true);
  });

  it("never exempts a read/search/fetch tool, however small its result", () => {
    for (const name of ["read", "glob", "grep", "web_fetch", "web_search", "spreadsheet", "bash", "op_status", "op_wait"]) {
      expect(isHeapGuardExempt(name)).toBe(false);
    }
  });
});

describe("refusal envelope", () => {
  const p = heapPressure({ used_heap_size: 3.9 * GB, heap_size_limit: 4 * GB });

  it("names used/limit MB and the percentage, and tells the model what to do instead", () => {
    const msg = heapRefusalMessage(p);
    expect(msg).toBe(
      "refused: server heap at 3994/4096 MB (98%); the previous tool results are too large to hold — " +
      "summarize what you have, avoid re-reading large files, or narrow the query",
    );
  });

  it("is a blocked envelope with a heap-guard layer whose recovery says finish, not retry smaller", () => {
    const r = heapRefusalResult(p);
    expect(r.status).toBe("blocked");
    expect(r.isError).toBe(true);
    expect(r.metadata?.layer).toBe("heap-guard");
    expect(r.metadata?.recovery).toBe(
      "No further tool calls will run until server memory frees (heap at 3994/4096 MB). " +
      "Do not retry or switch tools — summarize what you already have and finish the turn; " +
      "if you must ask something, use ask_user.",
    );
    // The guard is call-size agnostic — the recovery must not steer the model
    // toward a "smaller" retry that would be refused just the same.
    expect(String(r.metadata?.recovery)).not.toMatch(/offset|limit|smaller|narrow/);
    expect(typeof r.metadata?.userHint).toBe("string");
    expect(r.content).toContain("refused: server heap at 3994/4096 MB (98%)");
  });

  it("a fresh turn has not warned yet", () => {
    expect(newHeapGuardTurn()).toEqual({ warned: false });
  });
});

describe("sampleHeapPressure test seam", () => {
  afterEach(() => setHeapStatsForTests(null));

  it("reads the injected stats when a test source is set", () => {
    setHeapStatsForTests(() => ({ used_heap_size: 0.9 * GB, heap_size_limit: 1 * GB }));
    expect(sampleHeapPressure().ratio).toBeCloseTo(0.9, 6);
  });

  it("falls back to the real v8 statistics once the seam is cleared", () => {
    setHeapStatsForTests(() => ({ used_heap_size: 0.9 * GB, heap_size_limit: 1 * GB }));
    setHeapStatsForTests(null);
    const p = sampleHeapPressure();
    expect(p.limitMb).toBeGreaterThan(0);
    expect(p.ratio).toBeGreaterThanOrEqual(0);
    expect(p.ratio).toBeLessThan(1);
  });
});
