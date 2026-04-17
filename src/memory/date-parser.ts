/**
 * Query date parser — extracts a date range from natural-language queries.
 *
 * Returns HARD-confidence ranges for unambiguous expressions ("yesterday",
 * "last week", "March 15 2026") and SOFT ranges for fuzzy ones ("recently").
 * Callers use HARD to FILTER results; SOFT to BOOST.
 *
 * Pure function: takes string, returns DateRange | null. No timezone/locale
 * dependency beyond `now` — dates are interpreted in the local timezone.
 */

export type DateConfidence = "hard" | "soft";

export interface DateRange {
  start: Date;         // inclusive
  end: Date;           // exclusive (next-day-start convention)
  confidence: DateConfidence;
  matched: string;     // the substring that triggered the match, for debugging
}

const MS_DAY = 86_400_000;
const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

/** Return a start-of-day Date for the given Date (local time). */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_DAY);
}

/** Start of the week containing `d` (Sunday-based, local time). */
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

/** Start of month containing `d` (local time). */
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

/**
 * Parse a query string for temporal references.
 * Returns the FIRST matched range, or null.
 */
export function parseDateRange(query: string, now: Date = new Date()): DateRange | null {
  const q = query.toLowerCase();
  const today = startOfDay(now);

  // ── HARD: ISO date (2026-03-15) ──
  const isoDay = q.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoDay) {
    const d = new Date(`${isoDay[1]}-${isoDay[2]}-${isoDay[3]}T00:00:00`);
    if (!isNaN(d.getTime())) {
      return { start: d, end: addDays(d, 1), confidence: "hard", matched: isoDay[0] };
    }
  }

  // ── HARD: "yesterday" / "today" / "tomorrow" ──
  if (/\byesterday\b/.test(q)) {
    const s = addDays(today, -1);
    return { start: s, end: today, confidence: "hard", matched: "yesterday" };
  }
  if (/\btoday\b/.test(q)) {
    return { start: today, end: addDays(today, 1), confidence: "hard", matched: "today" };
  }
  if (/\btomorrow\b/.test(q)) {
    const s = addDays(today, 1);
    return { start: s, end: addDays(s, 1), confidence: "hard", matched: "tomorrow" };
  }

  // ── HARD: "N (days|weeks|months|years) ago" ──
  const ago = q.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\s+ago\b/);
  if (ago) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = /^\d+$/.test(ago[1]) ? parseInt(ago[1]) : (words[ago[1]] || 1);
    const unit = ago[2];
    let start: Date, end: Date;
    if (unit === "day") {
      start = addDays(today, -n);
      end = addDays(start, 1);
    } else if (unit === "week") {
      start = addDays(today, -7 * n);
      end = addDays(start, 7);
    } else if (unit === "month") {
      start = new Date(today.getFullYear(), today.getMonth() - n, 1);
      end = new Date(today.getFullYear(), today.getMonth() - n + 1, 1);
    } else {
      start = new Date(today.getFullYear() - n, 0, 1);
      end = new Date(today.getFullYear() - n + 1, 0, 1);
    }
    return { start, end, confidence: "hard", matched: ago[0] };
  }

  // ── HARD: "last week" / "this week" / "next week" ──
  if (/\blast\s+week\b/.test(q)) {
    const thisWk = startOfWeek(today);
    return { start: addDays(thisWk, -7), end: thisWk, confidence: "hard", matched: "last week" };
  }
  if (/\bthis\s+week\b/.test(q)) {
    const s = startOfWeek(today);
    return { start: s, end: addDays(s, 7), confidence: "hard", matched: "this week" };
  }
  if (/\bnext\s+week\b/.test(q)) {
    const s = addDays(startOfWeek(today), 7);
    return { start: s, end: addDays(s, 7), confidence: "hard", matched: "next week" };
  }

  // ── HARD: "last month" / "this month" / "last year" / "this year" ──
  if (/\blast\s+month\b/.test(q)) {
    const thisMo = startOfMonth(today);
    const lastMo = new Date(thisMo.getFullYear(), thisMo.getMonth() - 1, 1);
    return { start: lastMo, end: thisMo, confidence: "hard", matched: "last month" };
  }
  if (/\bthis\s+month\b/.test(q)) {
    const s = startOfMonth(today);
    const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    return { start: s, end: e, confidence: "hard", matched: "this month" };
  }
  if (/\blast\s+year\b/.test(q)) {
    const thisYr = startOfYear(today);
    const lastYr = new Date(thisYr.getFullYear() - 1, 0, 1);
    return { start: lastYr, end: thisYr, confidence: "hard", matched: "last year" };
  }
  if (/\bthis\s+year\b/.test(q)) {
    const s = startOfYear(today);
    const e = new Date(s.getFullYear() + 1, 0, 1);
    return { start: s, end: e, confidence: "hard", matched: "this year" };
  }

  // ── HARD: "Month Year" (e.g., "March 2026") ──
  for (const [name, idx] of Object.entries(MONTHS)) {
    const re = new RegExp(`\\b${name}\\s+(\\d{4})\\b`);
    const m = q.match(re);
    if (m) {
      const year = parseInt(m[1]);
      const start = new Date(year, idx, 1);
      const end = new Date(year, idx + 1, 1);
      return { start, end, confidence: "hard", matched: m[0] };
    }
  }

  // ── HARD: "in Month" (current year assumed, e.g., "in March") ──
  for (const [name, idx] of Object.entries(MONTHS)) {
    // Avoid 2-letter months ("may") false-positives — require "in " or standalone with year boundary
    if (name.length < 4 && name !== "may") continue;
    const re = new RegExp(`\\bin\\s+${name}\\b`);
    if (re.test(q)) {
      const year = today.getFullYear();
      const start = new Date(year, idx, 1);
      const end = new Date(year, idx + 1, 1);
      return { start, end, confidence: "hard", matched: `in ${name}` };
    }
  }

  // ── SOFT: "recently" ──
  if (/\brecent(ly)?\b/.test(q)) {
    return { start: addDays(today, -7), end: addDays(today, 1), confidence: "soft", matched: "recently" };
  }

  // ── SOFT: "a while ago" / "long ago" / "in the past" ──
  if (/\ba\s+while\s+ago\b|\blong\s+ago\b|\bin\s+the\s+past\b/.test(q)) {
    // No upper bound — just a signal that older is better
    return { start: new Date(0), end: addDays(today, -30), confidence: "soft", matched: "a while ago" };
  }

  return null;
}

/**
 * Check whether a chunk's date falls within the range.
 * chunkDateStr can be "2026-03-15" or "2026-03" (partial — matches the month).
 */
export function dateInRange(chunkDateStr: string | undefined, range: DateRange): boolean {
  if (!chunkDateStr) return false;
  // Try ISO day
  const iso = chunkDateStr.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!iso) return false;
  const year = parseInt(iso[1]);
  const month = parseInt(iso[2]) - 1;
  const day = iso[3] ? parseInt(iso[3]) : 15; // midpoint of month if day unknown
  const chunkDate = new Date(year, month, day);
  return chunkDate >= range.start && chunkDate < range.end;
}
