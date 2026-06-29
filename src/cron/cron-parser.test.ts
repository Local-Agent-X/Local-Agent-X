/**
 * Cron schedule-parser tests — focused on the timezone-awareness fix.
 *
 * Before this, cron expressions matched against the server's OS local time with
 * no way to pin a zone: a "0 9 * * *" job fired at 9am wherever the server ran,
 * not 9am for the user. These tests lock in two guarantees:
 *   1. No tz (or an unresolvable one) = legacy server-local behavior, unchanged.
 *   2. An explicit IANA tz makes the cron fields match WALL-CLOCK time in that
 *      zone — including date/day-of-week rollovers across the offset.
 */

import { describe, it, expect } from "vitest";
import {
  getCronFields,
  isValidTimeZone,
  msUntilNextCron,
  msUntilNextRun,
  getIntervalMs,
} from "./cron-parser.js";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects junk and empty", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("EST5EDT-nonsense")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("getCronFields — timezone extraction", () => {
  // Noon UTC: a fixed instant the same everywhere, so the per-zone wall clock
  // is deterministic regardless of the machine running the test.
  const noonUTC = new Date("2026-06-29T12:30:00Z");

  it("reads wall-clock minute/hour in the target zone", () => {
    expect(getCronFields(noonUTC, "UTC")).toMatchObject({ hour: 12, minute: 30 });
    // EDT is UTC-4 in June → 08:30.
    expect(getCronFields(noonUTC, "America/New_York")).toMatchObject({ hour: 8, minute: 30 });
    // JST is UTC+9 → 21:30.
    expect(getCronFields(noonUTC, "Asia/Tokyo")).toMatchObject({ hour: 21, minute: 30 });
  });

  it("rolls the date and day-of-week back across a negative offset", () => {
    // 02:00 UTC on Mon 2026-06-29; in Los Angeles (PDT, UTC-7) it's still
    // Sun 2026-06-28 19:00 — so day and weekday must roll back.
    const earlyMon = new Date("2026-06-29T02:00:00Z");
    expect(getCronFields(earlyMon, "UTC")).toMatchObject({ day: 29, dow: 1 }); // Monday
    expect(getCronFields(earlyMon, "America/Los_Angeles")).toMatchObject({ day: 28, dow: 0 }); // Sunday
  });

  it("falls back to server-local fields when tz is absent or invalid", () => {
    const d = new Date("2026-06-29T12:30:00Z");
    const local = {
      minute: d.getMinutes(),
      hour: d.getHours(),
      day: d.getDate(),
      month: d.getMonth() + 1,
      dow: d.getDay(),
    };
    expect(getCronFields(d)).toEqual(local);
    expect(getCronFields(d, "Not/AZone")).toEqual(local); // never throws on bad tz
  });
});

describe("msUntilNextCron — schedule matching", () => {
  it("no tz: next 9am lands on local 9:00 (legacy behavior unchanged)", () => {
    const ms = msUntilNextCron("0 9 * * *");
    expect(ms).not.toBeNull();
    const next = new Date(Date.now() + (ms as number));
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("with tz: next 9am lands on 9:00 wall-clock IN that zone", () => {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "Europe/London"]) {
      const ms = msUntilNextCron("0 9 * * *", tz);
      expect(ms).not.toBeNull();
      const next = new Date(Date.now() + (ms as number));
      const f = getCronFields(next, tz);
      expect(f.hour).toBe(9);
      expect(f.minute).toBe(0);
    }
  });

  it("every-minute matches within a minute regardless of tz", () => {
    expect(msUntilNextCron("* * * * *", "Asia/Kolkata")).toBe(60_000);
    expect(msUntilNextCron("* * * * *")).toBe(60_000);
  });

  it("returns null for non-cron (interval) strings", () => {
    expect(msUntilNextCron("5m")).toBeNull();
    expect(msUntilNextCron("not a schedule")).toBeNull();
  });
});

describe("msUntilNextRun + getIntervalMs — tz is ignored for intervals", () => {
  it("fixed intervals are timezone-independent", () => {
    // The tz arg must not change an interval's next-run.
    expect(msUntilNextRun("1h", "Asia/Tokyo")).toBe(getIntervalMs("1h"));
    expect(msUntilNextRun("1h")).toBe(getIntervalMs("1h"));
  });
});
