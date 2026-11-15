// An iCalendar (RFC 5545) document read into calendar events for a window:
// what an iCal feed (Google's "secret address in iCal format", iCloud and
// Outlook published calendars, any .ics link) and a CalDAV server hand back.
//
// Handled: line folding, escaped text, UTC / zoned / floating / all-day
// times (ics-time.ts), DURATION when there is no DTEND, recurrence
// (ics-recur.ts) with EXDATE exclusions and RECURRENCE-ID overrides (a moved
// or renamed occurrence replaces the generated one), and STATUS:CANCELLED.
// Anything unreadable is skipped, never thrown: one odd event must not hide a
// whole calendar.

import type { CalendarEvent } from "../types.js";
import { msOf, parseIcsTime, toIso, wallToMs, type IcsTime } from "./ics-time.js";
import { expandRule, parseRule } from "./ics-recur.js";

interface Prop { name: string; params: Record<string, string>; value: string }

/** Unfold continuation lines (CRLF followed by a space or tab). */
function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]|\n[ \t]/g, "").split(/\r?\n/);
}

function parseLine(line: string): Prop | null {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon <= 0) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

/** ISO 8601 duration ("PT1H30M", "P1D") in ms. */
export function durationMs(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60_000 + +(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

interface RawEvent {
  uid: string; title: string; location?: string; description?: string;
  start: IcsTime; durationMs: number; rrule?: string; exdates: number[];
  recurrenceIdMs?: number; cancelled: boolean;
}

function readEvent(props: Prop[]): RawEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const dtstart = get("DTSTART");
  const start = dtstart ? parseIcsTime(dtstart.value, dtstart.params) : null;
  if (!start) return null;
  const dtend = get("DTEND");
  const end = dtend ? parseIcsTime(dtend.value, dtend.params) : null;
  const dur = get("DURATION");
  const length = end ? msOf(end) - msOf(start) : dur ? durationMs(dur.value) : null;
  const rid = get("RECURRENCE-ID");
  const ridTime = rid ? parseIcsTime(rid.value, rid.params) : null;
  const exdates = props.filter((p) => p.name === "EXDATE").flatMap((p) =>
    p.value.split(",").map((v) => parseIcsTime(v, p.params)).filter((t): t is IcsTime => t !== null).map(msOf));
  return {
    uid: get("UID")?.value ?? "",
    title: unescape(get("SUMMARY")?.value ?? "(no title)"),
    ...(get("LOCATION")?.value ? { location: unescape(get("LOCATION")!.value) } : {}),
    ...(get("DESCRIPTION")?.value ? { description: unescape(get("DESCRIPTION")!.value).slice(0, 500) } : {}),
    start,
    durationMs: length !== null && length >= 0 ? length : start.allDay ? 86_400_000 : 0,
    ...(get("RRULE") ? { rrule: get("RRULE")!.value } : {}),
    exdates,
    ...(ridTime ? { recurrenceIdMs: msOf(ridTime) } : {}),
    cancelled: (get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
  };
}

/** Every VEVENT in the document, unread fields and all. */
function rawEvents(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  let current: Prop[] | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") { current = []; depth = 0; continue; }
    if (current && upper.startsWith("BEGIN:")) { depth++; continue; } // a VALARM inside
    if (current && upper.startsWith("END:") && depth > 0) { depth--; continue; }
    if (upper === "END:VEVENT" && current) { const e = readEvent(current); if (e) out.push(e); current = null; continue; }
    if (current && depth === 0) { const p = parseLine(line); if (p) current.push(p); }
  }
  return out;
}

function toEvent(e: RawEvent, start: IcsTime, sourceId: string): CalendarEvent {
  const startMs = msOf(start);
  const endIso = start.allDay
    ? toIso({ ...start, wall: wallOfDay(new Date(startMs + Math.max(e.durationMs, 86_400_000))) })
    : new Date(startMs + e.durationMs).toISOString();
  return {
    id: `${e.uid || e.title}@${startMs}`,
    title: e.title,
    start: toIso(start),
    end: endIso,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    sourceId,
  };
}

function wallOfDay(d: Date) {
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: 0, mi: 0, s: 0 };
}

/** The events of an iCalendar document that overlap [fromMs, toMs). */
export function parseIcs(text: string, fromMs: number, toMs: number, sourceId: string): CalendarEvent[] {
  const raw = rawEvents(text);
  // A RECURRENCE-ID event replaces the occurrence it names.
  const overrides = new Map<string, RawEvent>();
  for (const e of raw) if (e.recurrenceIdMs !== undefined) overrides.set(`${e.uid}@${e.recurrenceIdMs}`, e);
  const out: CalendarEvent[] = [];
  const keep = (e: RawEvent, start: IcsTime) => {
    const s = msOf(start);
    if (!e.cancelled && s < toMs && s + Math.max(e.durationMs, 1) > fromMs) out.push(toEvent(e, start, sourceId));
  };
  for (const e of raw) {
    if (e.recurrenceIdMs !== undefined) { keep(e, e.start); continue; }
    const rule = e.rrule ? parseRule(e.rrule, e.start.zone) : null;
    if (!rule) { keep(e, e.start); continue; }
    for (const wall of expandRule(e.start, rule, fromMs, toMs, e.durationMs)) {
      const occurrence: IcsTime = { ...e.start, wall };
      const ms = e.start.allDay ? msOf(occurrence) : wallToMs(wall, e.start.zone);
      if (e.exdates.includes(ms) || overrides.has(`${e.uid}@${ms}`)) continue;
      keep(e, occurrence);
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
