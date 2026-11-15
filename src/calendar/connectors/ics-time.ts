// Dates and times as iCalendar (RFC 5545) writes them, turned into instants.
//
// A DATE-TIME is one of three things: UTC ("20261114T170000Z"), wall-clock
// time in a named zone (TZID=America/Chicago:20261114T110000), or floating
// wall-clock time (no zone: the machine's local time). A DATE
// ("VALUE=DATE:20261114") is an all-day event. Recurrence is expanded on the
// wall clock (ics-recur.ts), so a weekly 9:00 meeting stays at 9:00 across a
// daylight-saving change; each occurrence is converted to an instant here.

/** A wall-clock time with no zone attached yet. Month is 1-12. */
export interface Wall {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
}

export interface IcsTime {
  wall: Wall;
  /** "utc", an IANA zone, or "local" (floating, and any zone we cannot read). */
  zone: string;
  allDay: boolean;
}

/** Windows zone names Outlook and Exchange write as TZID, to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "E. Europe Standard Time": "Europe/Bucharest",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "UTC": "UTC",
};

function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

/** The zone a TZID names, or "local" when it names none we can read. */
export function zoneOf(tzid: string | undefined): string {
  if (!tzid) return "local";
  const clean = tzid.replace(/^"|"$/g, "").replace(/^\/[^/]+\/[^/]+\//, "");
  const iana = WINDOWS_ZONES[clean] ?? clean;
  return validZone(iana) ? iana : "local";
}

/** Parse a DATE or DATE-TIME value with its TZID / VALUE parameters. */
export function parseIcsTime(value: string, params: Record<string, string>): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall: Wall = { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const allDay = params.VALUE === "DATE" || m[4] === undefined;
  if (allDay) return { wall, zone: "local", allDay: true };
  return { wall, zone: m[7] ? "utc" : zoneOf(params.TZID), allDay: false };
}

/** The zone's offset from UTC at the instant `utcMs`, in ms. */
function offsetAt(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a wall-clock time in `zone` names. */
export function wallToMs(wall: Wall, zone: string): number {
  if (zone === "local") return new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s).getTime();
  const naive = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  if (zone === "utc") return naive;
  // Two passes settle the offset across a daylight-saving boundary.
  let guess = naive - offsetAt(zone, naive);
  guess = naive - offsetAt(zone, guess);
  return guess;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** How the calendar layer writes it: an ISO instant, or "YYYY-MM-DD" all day. */
export function toIso(t: IcsTime): string {
  if (t.allDay) return `${t.wall.y}-${pad(t.wall.mo)}-${pad(t.wall.d)}`;
  return new Date(wallToMs(t.wall, t.zone)).toISOString();
}

/** The instant an IcsTime starts (an all-day one at local midnight). */
export function msOf(t: IcsTime): number {
  return t.allDay ? new Date(t.wall.y, t.wall.mo - 1, t.wall.d).getTime() : wallToMs(t.wall, t.zone);
}

/** Wall-clock arithmetic in whole days or months, normalized. */
export function addDays(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + days, w.h, w.mi, w.s));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
}

/** Day of week of a wall date, 0 = Sunday. */
export function weekday(w: Pick<Wall, "y" | "mo" | "d">): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
