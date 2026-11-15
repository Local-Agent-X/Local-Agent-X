// What every calendar looks like to the rest of LAX, whichever service holds
// it: LAX's own calendar.json today, a connected Google Calendar, an iCal (ICS)
// subscription or a CalDAV account as they are added. Code that needs to know
// when the user is busy reads `eventsBetween` (index.ts) and never one source.

/** One event, normalized. Times are ISO 8601 strings as the source gave them
 *  (a local time with no offset is the machine's local time). */
export interface CalendarEvent {
  /** Unique within its source. */
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  /** The `CalendarSource.id` it came from. */
  sourceId: string;
}

/** The kinds of calendar a source can be. "lax" is LAX's own calendar.json;
 *  the others name the connectors this seam is built for. */
export type CalendarSourceKind = "lax" | "google" | "ics" | "caldav";

/** A calendar LAX can read. A connector registers one per connected calendar
 *  account (registerCalendarSource); reading is all this interface asks of it. */
export interface CalendarSource {
  /** Stable id, e.g. "lax" or "google:<account>". */
  id: string;
  kind: CalendarSourceKind;
  /** What the user calls it ("LAX calendar", "Work (Google)"). */
  label: string;
  /** Events that overlap [from, to). Throws when the source cannot be read. */
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

/** Every source's events in a window, and which sources could not be read
 *  (their events are missing from the list, so a caller can say so). */
export interface CalendarWindow {
  events: CalendarEvent[];
  unreadable: Array<{ sourceId: string; label: string; error: string }>;
}
