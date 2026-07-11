import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyOpCategory,
	normalizeObservedToolName,
	recordOpOutcome,
	recordGaveUpNudge,
	getOpOutcomeStats,
	_resetOpOutcomeCache,
	createToolTracker,
	recordToolCall,
	getToolStats,
	getToolSuccessRate,
	getRecentFailures,
} from "./tool-tracker.js";

// op-outcome persistence resolves getLaxDir() lazily, so redirecting the write
// off ~/.lax in beforeAll (not at import) is enough. Restore so the env doesn't
// bleed into sibling test files sharing the worker.
let prevDataDir: string | undefined;
beforeAll(() => {
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-tt-"));
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
});

describe("classifyOpCategory", () => {
  it("ranks drive tools ahead of read-only ones", () => {
    expect(classifyOpCategory(new Set(["browser", "web_fetch"]))).toBe("browser");
    expect(classifyOpCategory(new Set(["web_fetch", "computer_click"]))).toBe("computer");
    expect(classifyOpCategory(new Set(["write", "web_search"]))).toBe("coding");
    expect(classifyOpCategory(new Set(["email_send"]))).toBe("connector");
    expect(classifyOpCategory(new Set(["web_search"]))).toBe("research");
  });

  it("falls back to general for uncategorized or empty tool sets", () => {
    expect(classifyOpCategory(new Set(["task_list"]))).toBe("general");
    expect(classifyOpCategory(new Set())).toBe("general");
  });

  it("normalizes MCP-prefixed observed tool names before matching", () => {
    expect(classifyOpCategory(new Set(["mcp__lax__browser"]))).toBe("browser");
    expect(classifyOpCategory(new Set(["mcp__lax__web_search"]))).toBe("research");
  });

  it("maps native WebSearch to research", () => {
    expect(classifyOpCategory(new Set(["WebSearch"]))).toBe("research");
  });

  it("passes bare dispatched names through unchanged", () => {
    expect(classifyOpCategory(new Set(["bash"]))).toBe("coding");
  });

  it("keeps family precedence after normalization", () => {
    expect(classifyOpCategory(new Set(["mcp__lax__web_search", "mcp__lax__browser"]))).toBe("browser");
  });
});

describe("normalizeObservedToolName", () => {
  it("strips the mcp__<server>__ prefix to the canonical name", () => {
    expect(normalizeObservedToolName("mcp__lax__write")).toBe("write");
  });

  it("leaves bare names unchanged", () => {
    expect(normalizeObservedToolName("bash")).toBe("bash");
  });
});

describe("op-outcome telemetry", () => {
  it("aggregates outcomes by category and model", () => {
    recordOpOutcome("browser", "clean", "grok-4.3");
    recordOpOutcome("browser", "partial", "grok-4.3");
    recordOpOutcome("coding", "aborted", "claude-opus-4-8");
    const stats = getOpOutcomeStats();
    expect(stats["browser::grok-4.3"]).toEqual({ total: 2, clean: 1, partial: 1, aborted: 0 });
    expect(stats["coding::claude-opus-4-8"]).toEqual({ total: 1, clean: 0, partial: 0, aborted: 1 });
  });

  it("survives a restart by reloading the aggregate from disk", () => {
    recordOpOutcome("research", "clean", "gpt-5");
    _resetOpOutcomeCache();
    expect(getOpOutcomeStats()["research::gpt-5"]?.total).toBe(1);
  });

  it("buckets a missing model under 'unknown'", () => {
    recordOpOutcome("general", "clean", undefined);
    expect(getOpOutcomeStats()["general::unknown"]?.clean).toBe(1);
  });

  it("regression (Bug A): a Claude op that only observed mcp__lax__browser records browser, not general", () => {
    // The exact failure this work fixed: Claude's CLI/MCP tools were invisible,
    // so every Claude op fell to general::claude-opus-4-8 (50/50 in the live
    // data). With observed-tool categorization, the mcp__lax__ name normalizes
    // and the op lands in its real category.
    recordOpOutcome(classifyOpCategory(new Set(["mcp__lax__browser"])), "clean", "claude-opus-4-8");
    const stats = getOpOutcomeStats();
    expect(stats["browser::claude-opus-4-8"]?.clean).toBe(1);
    expect(stats["general::claude-opus-4-8"]).toBeUndefined();
  });

  it("counts give-up nudges per model without bumping the outcome total", () => {
    recordGaveUpNudge("browser", "nudge-test-model");
    recordGaveUpNudge("browser", "nudge-test-model");
    const entry = getOpOutcomeStats()["browser::nudge-test-model"];
    expect(entry?.gaveUpNudged).toBe(2);
    expect(entry?.total).toBe(0); // the nudge fires mid-op — never the terminal outcome
  });

  it("give-up nudge count survives a restart", () => {
    recordGaveUpNudge("research", "nudge-restart-model");
    _resetOpOutcomeCache();
    expect(getOpOutcomeStats()["research::nudge-restart-model"]?.gaveUpNudged).toBe(1);
  });
});

describe("createToolTracker instance isolation", () => {
  it("two instances with different dirs don't share call records", () => {
    const dirA = mkdtempSync(join(tmpdir(), "lax-tt-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "lax-tt-b-"));
    const a = createToolTracker({ dir: dirA });
    const b = createToolTracker({ dir: dirB });

    a.recordToolCall("web_search", "s1", true, 100);
    a.recordToolCall("web_search", "s1", false, 50, "boom");

    expect(a.getToolStats().web_search).toEqual({
      totalCalls: 2,
      successes: 1,
      failures: 1,
      avgDurationMs: 75,
      lastFailure: "boom",
      lastFailureTime: expect.any(Number),
    });
    expect(b.getToolStats()).toEqual({});
    expect(a.getToolSuccessRate("web_search")).toBe(0.5);
    expect(b.getToolSuccessRate()).toBe(1); // empty → optimistic default, as before
    expect(a.getRecentFailures()).toHaveLength(1);
    expect(b.getRecentFailures()).toHaveLength(0);

    // Each instance persists to ITS dir, same file name + JSON shape as before.
    const persistedA = JSON.parse(readFileSync(join(dirA, "tool-stats.json"), "utf-8"));
    expect(persistedA.web_search.totalCalls).toBe(2);
    expect(existsSync(join(dirB, "tool-stats.json"))).toBe(false);
  });

  it("two instances with different dirs don't share op-outcome aggregates", () => {
    const dirA = mkdtempSync(join(tmpdir(), "lax-tt-oa-"));
    const dirB = mkdtempSync(join(tmpdir(), "lax-tt-ob-"));
    const a = createToolTracker({ dir: dirA });
    const b = createToolTracker({ dir: dirB });

    a.recordOpOutcome("coding", "clean", "model-x");

    expect(a.getOpOutcomeStats()["coding::model-x"]?.clean).toBe(1);
    expect(b.getOpOutcomeStats()["coding::model-x"]).toBeUndefined();
    expect(existsSync(join(dirA, "op-outcomes.json"))).toBe(true);
    expect(existsSync(join(dirB, "op-outcomes.json"))).toBe(false);
  });
});

describe("default-instance wrappers", () => {
  it("record/report through the module-level functions as before", () => {
    recordToolCall("bash", "sess-default", true, 40);
    recordToolCall("bash", "sess-default", false, 20, "exit 1");

    const stats = getToolStats();
    expect(stats.bash.totalCalls).toBe(2);
    expect(stats.bash.successes).toBe(1);
    expect(stats.bash.failures).toBe(1);
    expect(stats.bash.avgDurationMs).toBe(30);
    expect(stats.bash.lastFailure).toBe("exit 1");
    expect(getToolSuccessRate("bash")).toBe(0.5);
    expect(getRecentFailures().some((r) => r.name === "bash" && r.error === "exit 1")).toBe(true);
  });

  it("lazy-init proof: the default instance binds LAX_DATA_DIR set AFTER import", () => {
    // beforeAll (post-import) pointed LAX_DATA_DIR at a temp dir. The old code
    // bound getLaxDir() at import, which would have written tool-stats.json to
    // the real ~/.lax. The persisted summary landing in the temp dir proves the
    // default instance resolved its dir on first use, not at import.
    const file = join(process.env.LAX_DATA_DIR!, "tool-stats.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).bash.totalCalls).toBe(2);
  });
});
