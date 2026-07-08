/**
 * Unit tests for relative-age formatting of recalled memory files.
 *
 * Deterministic: `now` is a fixed epoch and every mtime is computed as an
 * offset from it, so there is no wall-clock dependency.
 */

import { describe, it, expect } from "vitest";
import { relativeAge, memoryStaleCaveat, STALE_MEMORY_THRESHOLD_MS } from "./relative-age.js";

const NOW = 1_700_000_000_000; // fixed reference clock
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeAge", () => {
  it("reads sub-minute ages as 'just now'", () => {
    expect(relativeAge(NOW, NOW)).toBe("just now");
    expect(relativeAge(NOW - 30 * SEC, NOW)).toBe("just now");
    expect(relativeAge(NOW - 59 * SEC, NOW)).toBe("just now");
  });

  it("clamps future / clock-skewed mtimes to 'just now'", () => {
    expect(relativeAge(NOW + 5 * MIN, NOW)).toBe("just now");
  });

  it("crosses the minute boundary at exactly 60s", () => {
    expect(relativeAge(NOW - 60 * SEC, NOW)).toBe("1 minute ago");
  });

  it("pluralizes minutes", () => {
    expect(relativeAge(NOW - 2 * MIN, NOW)).toBe("2 minutes ago");
    expect(relativeAge(NOW - 59 * MIN, NOW)).toBe("59 minutes ago");
  });

  it("crosses the hour boundary at 60 minutes", () => {
    expect(relativeAge(NOW - 60 * MIN, NOW)).toBe("1 hour ago");
    expect(relativeAge(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
    expect(relativeAge(NOW - 23 * HOUR, NOW)).toBe("23 hours ago");
  });

  it("crosses the day boundary at 24 hours", () => {
    expect(relativeAge(NOW - 24 * HOUR, NOW)).toBe("1 day ago");
    expect(relativeAge(NOW - 47 * DAY, NOW)).toBe("47 days ago");
  });

  it("floors partial units", () => {
    expect(relativeAge(NOW - (3 * HOUR + 59 * MIN), NOW)).toBe("3 hours ago");
    expect(relativeAge(NOW - (47 * DAY + 23 * HOUR), NOW)).toBe("47 days ago");
  });
});

describe("memoryStaleCaveat", () => {
  it("adds a stale caveat for memories older than ~1 day", () => {
    const caveat = memoryStaleCaveat(NOW - 2 * DAY, NOW);
    expect(caveat).not.toBe("");
    expect(caveat.toLowerCase()).toContain("outdated");
  });

  it("stays silent for a fresh memory", () => {
    expect(memoryStaleCaveat(NOW - 3 * HOUR, NOW)).toBe("");
    expect(memoryStaleCaveat(NOW, NOW)).toBe("");
  });

  it("uses a ~1-day threshold", () => {
    expect(STALE_MEMORY_THRESHOLD_MS).toBe(DAY);
    // Exactly at the threshold is not yet stale; just past it is.
    expect(memoryStaleCaveat(NOW - DAY, NOW)).toBe("");
    expect(memoryStaleCaveat(NOW - (DAY + 1), NOW)).not.toBe("");
  });
});
