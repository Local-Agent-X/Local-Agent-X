import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendarSources, eventsBetween, registerCalendarSource, type CalendarSource } from "./index.js";
import { loadCalendar, overlaps } from "./local-store.js";

let dir: string;
const prevDir = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-calendar-"));
  process.env.LAX_DATA_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

const writeEvents = (events: unknown[]) => writeFileSync(join(dir, "calendar.json"), JSON.stringify({ events }));
const from = new Date("2026-11-14T00:00:00Z");
const to = new Date("2026-11-15T00:00:00Z");

describe("calendar", () => {
  it("reads LAX's calendar.json through the always-present lax source", async () => {
    writeEvents([
      { id: "a", title: "Greg", start: "2026-11-14T17:00:00Z", end: "2026-11-14T18:00:00Z", description: "", attendees: [], location: "" },
      { id: "b", title: "Next week", start: "2026-11-21T17:00:00Z", end: "2026-11-21T18:00:00Z", description: "", attendees: [], location: "" },
    ]);
    expect(calendarSources().map((s) => s.id)).toContain("lax");
    const { events, unreadable } = await eventsBetween(from, to);
    expect(events.map((e) => e.title)).toEqual(["Greg"]);
    expect(events[0]?.sourceId).toBe("lax");
    expect(unreadable).toEqual([]);
  });

  it("merges a connected source in time order, and names one that fails without dropping the rest", async () => {
    writeEvents([{ id: "a", title: "Late", start: "2026-11-14T20:00:00Z", end: "2026-11-14T21:00:00Z", description: "", attendees: [], location: "" }]);
    const google: CalendarSource = {
      id: "google:test", kind: "google", label: "Work (Google)",
      listEvents: async () => [{ id: "g1", title: "Early", start: "2026-11-14T09:00:00Z", end: "2026-11-14T10:00:00Z", sourceId: "google:test" }],
    };
    const broken: CalendarSource = {
      id: "ics:broken", kind: "ics", label: "Feed", listEvents: async () => { throw new Error("feed down"); },
    };
    const off = [registerCalendarSource(google), registerCalendarSource(broken)];
    try {
      const { events, unreadable } = await eventsBetween(from, to);
      expect(events.map((e) => e.title)).toEqual(["Early", "Late"]);
      expect(unreadable).toEqual([{ sourceId: "ics:broken", label: "Feed", error: "feed down" }]);
    } finally {
      off.forEach((f) => f());
    }
    expect(calendarSources().map((s) => s.id)).toEqual(["lax"]);
  });

  it("treats a missing or malformed calendar.json as empty", async () => {
    expect(await loadCalendar()).toEqual({ events: [] });
    writeFileSync(join(dir, "calendar.json"), "{not json");
    expect(await loadCalendar()).toEqual({ events: [] });
  });

  it("overlap: an event touching the window counts, unparseable times never do", () => {
    expect(overlaps("2026-11-13T23:00:00Z", "2026-11-14T01:00:00Z", from, to)).toBe(true);
    expect(overlaps("2026-11-15T00:00:00Z", "2026-11-15T01:00:00Z", from, to)).toBe(false);
    expect(overlaps("soon", "later", from, to)).toBe(false);
  });
});
