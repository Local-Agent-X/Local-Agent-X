import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOpCategory, recordOpOutcome, getOpOutcomeStats, _resetOpOutcomeCache } from "./tool-tracker.js";

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
});
