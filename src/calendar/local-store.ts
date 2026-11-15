// LAX's own calendar: the events in <lax data dir>/calendar.json, written by
// the calendar_create_event tool and synced between devices by src/sync/.
// The one reader and writer of that file; the calendar tools and the
// "lax" calendar source both go through it.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import type { CalendarEvent, CalendarSource, PlanOrigin } from "./types.js";

/** An event as calendar.json stores it. */
export interface StoredCalendarEvent {
  id: string; title: string; start: string; end: string;
  description: string; attendees: string[]; location: string;
  /** Set when LAX noticed the plan itself (plans.ts). */
  origin?: PlanOrigin;
}
export interface CalendarData { events: StoredCalendarEvent[] }

function calendarPath(): string {
  return join(getLaxDir(), "calendar.json");
}

/** The stored calendar; an empty one when the file is missing or unreadable. */
export async function loadCalendar(): Promise<CalendarData> {
  try {
    const parsed = JSON.parse(await readFile(calendarPath(), "utf-8")) as Partial<CalendarData>;
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

export async function saveCalendar(data: CalendarData): Promise<void> {
  await mkdir(getLaxDir(), { recursive: true });
  await writeFile(calendarPath(), JSON.stringify(data, null, 2), "utf-8");
}

/** True when [start, end) overlaps [from, to). An event whose times do not
 *  parse overlaps nothing. */
export function overlaps(start: string, end: string, from: Date, to: Date): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end || start);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s < to.getTime() && Math.max(e, s) >= from.getTime();
}

export const LAX_CALENDAR_SOURCE_ID = "lax";

export const localCalendarSource: CalendarSource = {
  id: LAX_CALENDAR_SOURCE_ID,
  kind: "lax",
  label: "LAX calendar",
  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const { events } = await loadCalendar();
    return events
      .filter((e) => overlaps(e.start, e.end, from, to))
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        ...(e.location ? { location: e.location } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.attendees?.length ? { attendees: e.attendees } : {}),
        ...(e.origin ? { origin: e.origin } : {}),
        sourceId: LAX_CALENDAR_SOURCE_ID,
      }));
  },
};
