import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readDailyLogsInRange } from "./daily-log-range.js";

describe("readDailyLogsInRange", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "daily-log-range-"));
    writeFileSync(join(dir, "2026-04-16.md"), "## April 16\nShipped the recall fix.");
    writeFileSync(join(dir, "2026-04-17.md"), "## April 17\nWrote tests.");
    writeFileSync(join(dir, "2026-04-18.md"), ""); // empty → skipped
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the daily log for a single day (the date-recall regression)", () => {
    // The bug: recallByTime only queries the Facts DB, so a day with a log
    // but no extracted facts answered "no memory". This is the path that
    // makes that impossible.
    const out = readDailyLogsInRange(dir, new Date("2026-04-16"));
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-04-16");
    expect(out[0].content).toContain("Shipped the recall fix.");
  });

  it("returns logs across an inclusive range, oldest→newest, skipping empties", () => {
    const out = readDailyLogsInRange(dir, new Date("2026-04-16"), new Date("2026-04-18"));
    expect(out.map((e) => e.date)).toEqual(["2026-04-16", "2026-04-17"]);
  });

  it("returns nothing for a date with no file", () => {
    expect(readDailyLogsInRange(dir, new Date("2026-04-15"))).toEqual([]);
  });

  it("truncates a day over the per-day cap and flags it", () => {
    const out = readDailyLogsInRange(dir, new Date("2026-04-16"), undefined, { maxCharsPerDay: 5 });
    expect(out[0].truncated).toBe(true);
    expect(out[0].content.length).toBe(5);
  });

  it("ignores an inverted range", () => {
    expect(readDailyLogsInRange(dir, new Date("2026-04-18"), new Date("2026-04-16"))).toEqual([]);
  });
});
