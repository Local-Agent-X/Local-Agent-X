import { describe, expect, it } from "vitest";
import { parseIcs, durationMs } from "./ics.js";
import { wallToMs, zoneOf } from "./ics-time.js";

const cal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const range = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;

describe("iCalendar times", () => {
  it("reads UTC, a named zone (DST-correct), and a Windows zone name", () => {
    const [from, to] = range("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    const evs = parseIcs(cal(
      vevent("UID:a", "SUMMARY:UTC", "DTSTART:20261114T170000Z", "DTEND:20261114T180000Z"),
      vevent("UID:b", "SUMMARY:Chicago summer", "DTSTART;TZID=America/Chicago:20260710T090000", "DTEND;TZID=America/Chicago:20260710T100000"),
      vevent("UID:c", "SUMMARY:Chicago winter", "DTSTART;TZID=America/Chicago:20261210T090000", "DURATION:PT30M"),
      vevent("UID:d", "SUMMARY:Outlook", "DTSTART;TZID=Eastern Standard Time:20261210T090000", "DTEND;TZID=Eastern Standard Time:20261210T093000"),
    ), from, to, "ics:test");
    const by = (t: string) => evs.find((e) => e.title === t)!;
    expect(by("UTC").start).toBe("2026-11-14T17:00:00.000Z");
    expect(by("Chicago summer").start).toBe("2026-07-10T14:00:00.000Z"); // CDT, UTC-5
    expect(by("Chicago winter").start).toBe("2026-12-10T15:00:00.000Z"); // CST, UTC-6
    expect(by("Chicago winter").end).toBe("2026-12-10T15:30:00.000Z");
    expect(by("Outlook").start).toBe("2026-12-10T14:00:00.000Z");
    expect(zoneOf("Not/AZone")).toBe("local");
  });

  it("unfolds lines, unescapes text, and keeps all-day events as dates", () => {
    const [from, to] = range("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    const [e] = parseIcs(cal(vevent(
      "UID:x", "SUMMARY:Thanksgiving\\, at Mom\\'s", "DESCRIPTION:Bring pie\\nand", " rolls", "LOCATION:Mom\\;s house",
      "DTSTART;VALUE=DATE:20261126", "DTEND;VALUE=DATE:20261127",
    )), from, to, "ics:test");
    expect(e!.title).toBe("Thanksgiving, at Mom\\'s");
    expect(e!.description).toBe("Bring pie\nandrolls");
    expect(e!.location).toBe("Mom;s house");
    expect(e!.start).toBe("2026-11-26");
    expect(e!.end).toBe("2026-11-27");
  });

  it("parses durations", () => {
    expect(durationMs("PT1H30M")).toBe(90 * 60_000);
    expect(durationMs("P1D")).toBe(86_400_000);
    expect(durationMs("P1W")).toBe(7 * 86_400_000);
    expect(durationMs("nope")).toBeNull();
  });
});

describe("recurrence", () => {
  it("a weekly 9:00 meeting stays at 9:00 local across a daylight-saving change, with COUNT", () => {
    const [from, to] = range("2026-10-20T00:00:00Z", "2026-11-30T00:00:00Z");
    const evs = parseIcs(cal(vevent(
      "UID:w", "SUMMARY:Standup", "DTSTART;TZID=America/Chicago:20261026T090000", "DURATION:PT15M", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
    )), from, to, "ics:test");
    expect(evs.map((e) => e.start)).toEqual([
      "2026-10-26T14:00:00.000Z", "2026-10-28T14:00:00.000Z", // CDT
      "2026-11-02T15:00:00.000Z", "2026-11-04T15:00:00.000Z", // CST after Nov 1
    ]);
  });

  it("monthly on the 2nd Tuesday and the last Friday, yearly birthdays, UNTIL", () => {
    const [from, to] = range("2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z");
    const evs = parseIcs(cal(
      vevent("UID:m", "SUMMARY:Board", "DTSTART:20260113T170000Z", "DTEND:20260113T180000Z", "RRULE:FREQ=MONTHLY;BYDAY=2TU"),
      vevent("UID:l", "SUMMARY:Payday", "DTSTART;VALUE=DATE:20260130", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231"),
      vevent("UID:y", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:19900115", "RRULE:FREQ=YEARLY"),
    ), from, to, "ics:test");
    const starts = (t: string) => evs.filter((e) => e.title === t).map((e) => e.start.slice(0, 10));
    expect(starts("Board")).toEqual(["2026-11-10", "2026-12-08", "2027-01-12"]);
    expect(starts("Payday")).toEqual(["2026-11-27", "2026-12-25"]);
    expect(starts("Birthday")).toEqual(["2027-01-15"]);
  });

  it("a daily event from years ago still reaches today", () => {
    const [from, to] = range("2026-11-14T00:00:00Z", "2026-11-16T00:00:00Z");
    const evs = parseIcs(cal(vevent("UID:d", "SUMMARY:Pills", "DTSTART:20100101T130000Z", "DURATION:PT5M", "RRULE:FREQ=DAILY")), from, to, "ics:test");
    expect(evs.map((e) => e.start)).toEqual(["2026-11-14T13:00:00.000Z", "2026-11-15T13:00:00.000Z"]);
  });

  it("drops EXDATE occurrences, applies a moved occurrence, and skips cancelled events", () => {
    const [from, to] = range("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z");
    const evs = parseIcs(cal(
      vevent("UID:r", "SUMMARY:Gym", "DTSTART:20261102T120000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20261109T120000Z"),
      vevent("UID:r", "SUMMARY:Gym (moved)", "RECURRENCE-ID:20261116T120000Z", "DTSTART:20261117T180000Z", "DURATION:PT1H"),
      vevent("UID:z", "SUMMARY:Called off", "STATUS:CANCELLED", "DTSTART:20261110T120000Z", "DURATION:PT1H"),
    ), from, to, "ics:test");
    expect(evs.map((e) => `${e.title} ${e.start}`)).toEqual([
      "Gym 2026-11-02T12:00:00.000Z",
      "Gym (moved) 2026-11-17T18:00:00.000Z",
      "Gym 2026-11-23T12:00:00.000Z",
    ]);
  });

  it("ignores junk without throwing", () => {
    expect(parseIcs("not a calendar", 0, Date.now(), "x")).toEqual([]);
    expect(parseIcs(cal(vevent("SUMMARY:no start")), 0, Date.now(), "x")).toEqual([]);
    expect(Number.isFinite(wallToMs({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, "America/Chicago"))).toBe(true); // a time that does not exist
  });
});
