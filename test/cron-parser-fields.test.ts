import { describe, it, expect, afterEach, vi } from "vitest";
import { cronFieldMatches, msSinceLastCronOccurrence } from "../src/cron/cron-parser.js";

describe("cronFieldMatches", () => {
  it("wildcard '*' matches any value", () => {
    expect(cronFieldMatches("*", 0, 59)).toBe(true);
    expect(cronFieldMatches("*", 37, 59)).toBe(true);
    expect(cronFieldMatches("*", 59, 59)).toBe(true);
  });

  it("exact value matches only that value", () => {
    expect(cronFieldMatches("15", 15, 59)).toBe(true);
    expect(cronFieldMatches("15", 14, 59)).toBe(false);
    expect(cronFieldMatches("0", 0, 59)).toBe(true);
  });

  it("range a-b matches inclusive endpoints and interior", () => {
    expect(cronFieldMatches("9-17", 9, 23)).toBe(true);
    expect(cronFieldMatches("9-17", 17, 23)).toBe(true);
    expect(cronFieldMatches("9-17", 13, 23)).toBe(true);
    expect(cronFieldMatches("9-17", 8, 23)).toBe(false);
    expect(cronFieldMatches("9-17", 18, 23)).toBe(false);
  });

  it("step */n matches multiples of n", () => {
    expect(cronFieldMatches("*/15", 0, 59)).toBe(true);
    expect(cronFieldMatches("*/15", 15, 59)).toBe(true);
    expect(cronFieldMatches("*/15", 30, 59)).toBe(true);
    expect(cronFieldMatches("*/15", 45, 59)).toBe(true);
    expect(cronFieldMatches("*/15", 7, 59)).toBe(false);
    expect(cronFieldMatches("*/15", 20, 59)).toBe(false);
  });

  it("list a,b,c matches any listed value and nothing else", () => {
    expect(cronFieldMatches("1,15,30", 1, 59)).toBe(true);
    expect(cronFieldMatches("1,15,30", 15, 59)).toBe(true);
    expect(cronFieldMatches("1,15,30", 30, 59)).toBe(true);
    expect(cronFieldMatches("1,15,30", 2, 59)).toBe(false);
    expect(cronFieldMatches("1,15,30", 0, 59)).toBe(false);
  });

  it("list combining a range and a step matches if any part matches", () => {
    // "9-12" OR "*/30" -> 10 is in range, 30 is a step multiple, 7 is neither
    expect(cronFieldMatches("9-12,*/30", 10, 59)).toBe(true);
    expect(cronFieldMatches("9-12,*/30", 30, 59)).toBe(true);
    expect(cronFieldMatches("9-12,*/30", 7, 59)).toBe(false);
  });

  it("tolerates whitespace around list parts", () => {
    expect(cronFieldMatches("1, 15, 30", 15, 59)).toBe(true);
    expect(cronFieldMatches("1, 15, 30", 2, 59)).toBe(false);
  });

  it("BUG-PIN: step */n always matches value 0 even when 0 is not a valid step occurrence semantically", () => {
    // value % step === 0 is true for value 0 regardless of step. For dow (0=Sunday)
    // a field like "*/2" therefore matches Sunday. This pins current behavior.
    expect(cronFieldMatches("*/2", 0, 6)).toBe(true);
  });
});

describe("msSinceLastCronOccurrence (fake-timer fixed clock)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeAt(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  it("returns null for a non-5-field (interval) schedule", () => {
    freezeAt("2026-06-02T12:00:00.000Z");
    expect(msSinceLastCronOccurrence("5m")).toBeNull();
  });

  it("finds the most recent matching minute one minute back", () => {
    // every-minute schedule; now at :30s of 12:00, last occurrence was 11:59 (60s ago)
    // Use a tz-stable assertion: every-minute always matches the prior whole minute.
    freezeAt("2026-06-02T12:00:30.000Z");
    // schedule "* * * * *" matches every minute. Candidate now-1min = 11:59:30 matches.
    expect(msSinceLastCronOccurrence("* * * * *")).toBe(60_000);
  });

  it("returns null when lastRun is at or after the most recent occurrence", () => {
    freezeAt("2026-06-02T12:00:30.000Z");
    // last occurrence is 11:59:30 (local). lastRun set to 'now' is definitely >= it.
    const lastRun = new Date("2026-06-02T12:00:30.000Z").toISOString();
    expect(msSinceLastCronOccurrence("* * * * *", lastRun)).toBeNull();
  });

  it("returns the offset when lastRun is older than the most recent occurrence", () => {
    freezeAt("2026-06-02T12:00:30.000Z");
    // lastRun well in the past -> the 60s-ago occurrence is still 'missed'
    const lastRun = new Date("2026-06-02T10:00:00.000Z").toISOString();
    expect(msSinceLastCronOccurrence("* * * * *", lastRun)).toBe(60_000);
  });

  it("boundary: lastRun exactly equal to the candidate time suppresses the run", () => {
    // The most-recent every-minute occurrence is exactly 60s before 'now'.
    // Pick a now that lands on a whole-minute boundary so the candidate is a clean minute.
    freezeAt("2026-06-02T12:05:00.000Z");
    // candidate at offset 1 = 12:04:00. Its getTime() is a clean minute.
    const candidateMs = new Date("2026-06-02T12:04:00.000Z").getTime();
    const lastRun = new Date(candidateMs).toISOString();
    // lastRun >= candidate -> null (already ran)
    expect(msSinceLastCronOccurrence("* * * * *", lastRun)).toBeNull();
    // lastRun one ms before candidate -> not yet run -> 60_000
    const lastRunJustBefore = new Date(candidateMs - 1).toISOString();
    expect(msSinceLastCronOccurrence("* * * * *", lastRunJustBefore)).toBe(60_000);
  });

  it("returns null when no candidate in the 2880-minute window matches", () => {
    freezeAt("2026-06-02T12:00:00.000Z");
    // Impossible: month 13 never occurs -> never matches -> null.
    expect(msSinceLastCronOccurrence("* * * 13 *")).toBeNull();
  });
});
