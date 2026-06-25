import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOpCategory, normalizeObservedToolName, recordOpOutcome, getOpOutcomeStats, _resetOpOutcomeCache } from "./tool-tracker.js";

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
});
