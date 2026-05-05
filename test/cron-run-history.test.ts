import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHistoryStore, newRunId, summarize, type CronRunRecord } from "../src/cron/run-history.js";

let dataDir: string;

function makeRecord(overrides: Partial<CronRunRecord> = {}): CronRunRecord {
  return {
    id: newRunId(),
    jobId: "cron_abc",
    jobName: "Test Job",
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 4000,
    status: "success",
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cron-history-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("RunHistoryStore", () => {
  it("appends and lists run records newest-first", () => {
    const store = new RunHistoryStore(dataDir);
    store.append(makeRecord({ startedAt: "2026-01-01T00:00:01.000Z" }));
    store.append(makeRecord({ startedAt: "2026-01-01T00:00:02.000Z", status: "failed", errorMessage: "bad" }));
    store.append(makeRecord({ startedAt: "2026-01-01T00:00:03.000Z", status: "skipped" }));

    const out = store.list("cron_abc");
    expect(out).toHaveLength(3);
    expect(out[0].startedAt).toBe("2026-01-01T00:00:03.000Z");
    expect(out[0].status).toBe("skipped");
    expect(out[2].startedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("respects the per-job limit by trimming oldest entries", () => {
    const store = new RunHistoryStore(dataDir, 5);
    for (let i = 0; i < 10; i++) {
      store.append(makeRecord({ startedAt: `2026-01-01T00:00:${i.toString().padStart(2, "0")}.000Z` }));
    }
    const out = store.list("cron_abc", 100);
    expect(out).toHaveLength(5);
    // Newest five kept (00:05 .. 00:09)
    expect(out[0].startedAt).toBe("2026-01-01T00:00:09.000Z");
    expect(out[4].startedAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("purge removes the per-job history file", () => {
    const store = new RunHistoryStore(dataDir);
    store.append(makeRecord());
    expect(store.list("cron_abc")).toHaveLength(1);
    store.purge("cron_abc");
    expect(existsSync(join(dataDir, "cron", "history", "cron_abc.jsonl"))).toBe(false);
    expect(store.list("cron_abc")).toHaveLength(0);
  });

  it("isolates records per jobId", () => {
    const store = new RunHistoryStore(dataDir);
    store.append(makeRecord({ jobId: "cron_a", jobName: "A" }));
    store.append(makeRecord({ jobId: "cron_b", jobName: "B" }));
    expect(store.list("cron_a").map(r => r.jobName)).toEqual(["A"]);
    expect(store.list("cron_b").map(r => r.jobName)).toEqual(["B"]);
  });

  it("recent() returns records across all jobs newest-first", () => {
    const store = new RunHistoryStore(dataDir);
    store.append(makeRecord({ jobId: "cron_a", startedAt: "2026-01-01T00:00:01.000Z" }));
    store.append(makeRecord({ jobId: "cron_b", startedAt: "2026-01-01T00:00:03.000Z" }));
    store.append(makeRecord({ jobId: "cron_a", startedAt: "2026-01-01T00:00:02.000Z" }));
    const recent = store.recent(10);
    expect(recent.map(r => r.startedAt)).toEqual([
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:01.000Z",
    ]);
  });

  it("survives a corrupt line in the JSONL file", () => {
    const store = new RunHistoryStore(dataDir);
    store.append(makeRecord());
    const file = join(dataDir, "cron", "history", "cron_abc.jsonl");
    const raw = readFileSync(file, "utf-8");
    // Inject a garbage line
    require("node:fs").writeFileSync(file, raw + "{not-valid-json\n", "utf-8");
    const out = store.list("cron_abc");
    expect(out).toHaveLength(1);
  });
});

describe("summarize()", () => {
  it("returns trimmed input under the cap unchanged", () => {
    expect(summarize("  hello  ")).toBe("hello");
  });

  it("truncates with an ellipsis past the cap", () => {
    const long = "x".repeat(600);
    const out = summarize(long, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for falsy input", () => {
    expect(summarize("")).toBe("");
  });
});
