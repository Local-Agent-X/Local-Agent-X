// What a memory search reads as a date range in the user's words, and which
// rule wins when a query matches more than one.
import { describe, expect, it } from "vitest";
import { dateInRange, parseDateRange, type DateRange } from "./date-parser.js";

// A Wednesday, local time.
const NOW = new Date(2026, 2, 18, 15, 30);
const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

function range(query: string): DateRange {
  const r = parseDateRange(query, NOW);
  if (!r) throw new Error(`no range for: ${query}`);
  return r;
}

describe("parseDateRange", () => {
  it("returns null when the query names no time", () => {
    expect(parseDateRange("what did we decide about the cage", NOW)).toBeNull();
  });

  it("reads an ISO day as that day", () => {
    expect(range("notes from 2026-03-15")).toMatchObject({ start: day(2026, 3, 15), end: day(2026, 3, 16), confidence: "hard", matched: "2026-03-15" });
  });

  it("reads yesterday, today and tomorrow against the given now", () => {
    expect(range("what did I do yesterday")).toMatchObject({ start: day(2026, 3, 17), end: day(2026, 3, 18) });
    expect(range("today's plan")).toMatchObject({ start: day(2026, 3, 18), end: day(2026, 3, 19) });
    expect(range("tomorrow")).toMatchObject({ start: day(2026, 3, 19), end: day(2026, 3, 20) });
  });

  it("reads 'N units ago' as the day, week, month or year that far back", () => {
    expect(range("3 days ago")).toMatchObject({ start: day(2026, 3, 15), end: day(2026, 3, 16), confidence: "hard", matched: "3 days ago" });
    expect(range("a week ago")).toMatchObject({ start: day(2026, 3, 11), end: day(2026, 3, 18), matched: "a week ago" });
    expect(range("two months ago")).toMatchObject({ start: day(2026, 1, 1), end: day(2026, 2, 1), matched: "two months ago" });
    expect(range("one year ago")).toMatchObject({ start: day(2025, 1, 1), end: day(2026, 1, 1), matched: "one year ago" });
  });

  it("reads last, this and next week, and last and this month and year", () => {
    const thisWeek = range("this week");
    expect(thisWeek.end.getTime() - thisWeek.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(thisWeek.start <= day(2026, 3, 18) && day(2026, 3, 18) < thisWeek.end).toBe(true);
    expect(range("last week").end).toEqual(thisWeek.start);
    expect(range("next week").start).toEqual(thisWeek.end);
    expect(range("last month")).toMatchObject({ start: day(2026, 2, 1), end: day(2026, 3, 1) });
    expect(range("this month")).toMatchObject({ start: day(2026, 3, 1), end: day(2026, 4, 1) });
    expect(range("last year")).toMatchObject({ start: day(2025, 1, 1), end: day(2026, 1, 1) });
    expect(range("this year")).toMatchObject({ start: day(2026, 1, 1), end: day(2027, 1, 1) });
  });

  it("reads a named month, with a year or after 'in'", () => {
    expect(range("march 2025 trip")).toMatchObject({ start: day(2025, 3, 1), end: day(2025, 4, 1), matched: "march 2025" });
    expect(range("what happened in january")).toMatchObject({ start: day(2026, 1, 1), end: day(2026, 2, 1), matched: "in january" });
  });

  it("reads vague words as soft ranges", () => {
    expect(range("recently")).toMatchObject({ start: day(2026, 3, 11), end: day(2026, 3, 19), confidence: "soft" });
    expect(range("a while ago")).toMatchObject({ end: day(2026, 2, 16), confidence: "soft", matched: "a while ago" });
  });

  // Where clocks change (the US: 2026-03-08 and 2026-11-01), a day is 23 or 25
  // hours long. Ranges are whole calendar days all the same. In a zone with no
  // clock change these hold trivially.
  it("keeps day ranges on midnight across a clock change", () => {
    const afterFallBack = new Date(2026, 10, 3, 9, 0);
    const r = parseDateRange("3 days ago", afterFallBack)!;
    expect(r.start).toEqual(day(2026, 10, 31));
    expect(r.end).toEqual(day(2026, 11, 1));
    expect(dateInRange("2026-10-31", r)).toBe(true);
    const afterSpringForward = new Date(2026, 2, 10, 9, 0);
    expect(parseDateRange("3 days ago", afterSpringForward)!.start).toEqual(day(2026, 3, 7));
  });

  it("takes the first rule that matches: an ISO day before 'yesterday', 'yesterday' before 'N ago'", () => {
    expect(range("yesterday, 2026-01-05").matched).toBe("2026-01-05");
    expect(range("yesterday or 3 days ago").matched).toBe("yesterday");
    expect(range("3 days ago, last week").matched).toBe("3 days ago");
  });
});

describe("dateInRange", () => {
  it("places a day, or a month given without a day, inside or outside a range", () => {
    const march = range("this month");
    expect(dateInRange("2026-03-15", march)).toBe(true);
    expect(dateInRange("2026-03", march)).toBe(true);
    expect(dateInRange("2026-04-02", march)).toBe(false);
    expect(dateInRange(undefined, march)).toBe(false);
    expect(dateInRange("not a date", march)).toBe(false);
  });
});
