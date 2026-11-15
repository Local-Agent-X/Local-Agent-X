// calendar/ — every calendar the user has, read as one. See AGENTS.md here.
//
// LAX's own calendar.json is always a source. A calendar connector (Google
// Calendar, an iCal feed, CalDAV) registers one source per connected calendar
// and removes it on disconnect; nothing that reads the user's time changes.

import { createLogger } from "../logger.js";
import { localCalendarSource } from "./local-store.js";
import type { CalendarEvent, CalendarSource, CalendarWindow } from "./types.js";

export type { CalendarEvent, CalendarSource, CalendarSourceKind, CalendarWindow } from "./types.js";
export { LAX_CALENDAR_SOURCE_ID } from "./local-store.js";

const logger = createLogger("calendar");

const sources = new Map<string, CalendarSource>([[localCalendarSource.id, localCalendarSource]]);

/** Add (or replace, by id) a connected calendar. Returns its removal. */
export function registerCalendarSource(source: CalendarSource): () => void {
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
}

export function calendarSources(): CalendarSource[] {
  return [...sources.values()];
}

/** Every source's events overlapping [from, to), soonest first. A source that
 *  fails is named in `unreadable`, never dropped silently, and never fails the
 *  others. */
export async function eventsBetween(from: Date, to: Date): Promise<CalendarWindow> {
  const all = calendarSources();
  const results = await Promise.allSettled(all.map((s) => s.listEvents(from, to)));
  const events: CalendarEvent[] = [];
  const unreadable: CalendarWindow["unreadable"] = [];
  results.forEach((r, i) => {
    const source = all[i]!;
    if (r.status === "fulfilled") events.push(...r.value);
    else {
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.warn(`[calendar] ${source.label} could not be read: ${error}`);
      unreadable.push({ sourceId: source.id, label: source.label, error });
    }
  });
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { events, unreadable };
}
