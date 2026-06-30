// Schedule expression helpers for the cron service.
//
// Supports two forms:
//   - simple intervals: "5m", "1h", "30s", "1d"
//   - 5-field cron expressions: "minute hour dom month dow"
//     with star, "*\/N", "N-M", and "N,M,..." per field.
//
// Cron expressions match against wall-clock time in an OPTIONAL IANA timezone
// (e.g. "America/New_York"). When no tz is given the match uses the server's OS
// local time — the historical behavior, kept identical for backward compat.
// Intervals ("5m", "1h") are timezone-independent and ignore the tz entirely.

/** The five calendar fields a cron expression matches against. */
interface CronFields {
  minute: number;
  hour: number;
  day: number;
  month: number; // 1-12
  dow: number; // 0-6, Sunday=0
}

/** True if `tz` is a valid IANA timezone identifier this runtime can resolve. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    // Intl throws RangeError on an unknown zone; a valid one constructs cleanly.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the cron-relevant calendar fields of `date` as observed in `tz`.
 * With no tz (or an unresolvable one) falls back to server-local time so the
 * scheduler can never crash on a bad zone — it just reverts to legacy behavior.
 */
export function getCronFields(date: Date, tz?: string): CronFields {
  if (!tz || !isValidTimeZone(tz)) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = parseInt(p.value, 10);
  // Some engines emit hour "24" for midnight under hour12:false — normalize.
  const hour = f.hour === 24 ? 0 : f.hour;
  // Day-of-week is unambiguous once we have the y/m/d in the target zone:
  // build that calendar date in UTC and read its weekday (no DST edge cases —
  // the date itself, not a wall-clock instant, determines the weekday).
  const dow = new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
  return { minute: f.minute, hour, day: f.day, month: f.month, dow };
}

/** Parse simple interval strings like "5m", "1h", "30s". Returns ms or null. */
export function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * (multipliers[unit] || 60000);
}

/**
 * Structural validity of one cron field against its [min,max] range. Accepts
 * `*`, `*\/N`, `N-M` ranges, `N,M` lists, and bare `N` — every numeric token
 * must sit in range. This is SEPARATE from "does it match soon": a monthly cron
 * is structurally valid even though its next run is weeks away (past the
 * next-run search window), so validation must not lean on msUntilNextCron.
 */
function isValidCronField(field: string, min: number, max: number): boolean {
  if (!field) return false;
  for (const raw of field.split(",")) {
    const part = raw.trim();
    if (part === "*") continue;
    if (part.startsWith("*/")) {
      const step = part.slice(2);
      if (!/^\d+$/.test(step) || parseInt(step) <= 0) return false;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = +range[1], hi = +range[2];
      if (lo < min || hi > max || lo > hi) return false;
      continue;
    }
    if (/^\d+$/.test(part)) {
      const v = +part;
      if (v < min || v > max) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** True if `schedule` is a structurally-valid 5-field cron expression. */
export function isValidCronExpression(schedule: string): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    isValidCronField(parts[0], 0, 59) && // minute
    isValidCronField(parts[1], 0, 23) && // hour
    isValidCronField(parts[2], 1, 31) && // day-of-month
    isValidCronField(parts[3], 1, 12) && // month
    isValidCronField(parts[4], 0, 6) //    day-of-week (Sun=0)
  );
}

/**
 * Single source of truth for "the cron service can run this schedule": a fixed
 * interval ("5m") OR a structurally-valid cron expression. Used by create()
 * validation, the NL short-circuit/gate, and the form preview. Does NOT use
 * msUntilNextCron — its 24h no-match fallback would green-light garbage like
 * "every other tuesday at 3pm" (5 non-numeric tokens that match nothing).
 */
export function isValidSchedule(schedule: string): boolean {
  return getIntervalMs(schedule) !== null || isValidCronExpression(schedule);
}

/** Match a single cron field. Supports: *, N, star-slash-N, N-M, comma lists. */
export function cronFieldMatches(field: string, value: number, _max: number): boolean {
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") return true;
    if (trimmed.startsWith("*/")) {
      const step = parseInt(trimmed.slice(2));
      if (!isNaN(step) && step > 0 && value % step === 0) return true;
    } else if (trimmed.includes("-")) {
      const [lo, hi] = trimmed.split("-").map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      if (parseInt(trimmed) === value) return true;
    }
  }
  return false;
}

/** True if `candidate`'s wall-clock fields (in `tz`) match all five cron fields. */
function cronMatchesAt(
  candidate: Date,
  fields: { min: string; hour: string; dom: string; mon: string; dow: string },
  tz?: string,
): boolean {
  const f = getCronFields(candidate, tz);
  return (
    cronFieldMatches(fields.min, f.minute, 59) &&
    cronFieldMatches(fields.hour, f.hour, 23) &&
    cronFieldMatches(fields.dom, f.day, 31) &&
    cronFieldMatches(fields.mon, f.month, 12) &&
    cronFieldMatches(fields.dow, f.dow, 6)
  );
}

/** Calculate ms until the next cron match, evaluated in `tz`. Null for non-cron. */
export function msUntilNextCron(schedule: string, tz?: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  const now = new Date();
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() + offset * 60_000);
    if (cronMatchesAt(candidate, { min, hour, dom, mon, dow }, tz)) {
      return offset * 60_000;
    }
  }
  return 24 * 3600_000;
}

/** How long ago the most recent matching cron time was, in `tz`. Null if none. */
export function msSinceLastCronOccurrence(schedule: string, lastRun?: string, tz?: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  const now = new Date();
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() - offset * 60_000);
    if (cronMatchesAt(candidate, { min, hour, dom, mon, dow }, tz)) {
      if (lastRun && new Date(lastRun).getTime() >= candidate.getTime()) return null;
      return offset * 60_000;
    }
  }
  return null;
}

/** For interval/uniform schedules, return fixed ms. For full cron expressions, null. */
export function getIntervalMs(schedule: string): number | null {
  const interval = parseInterval(schedule);
  if (interval) return Math.max(interval, 60000);
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5 && parts[0].startsWith("*/") && parts.slice(1).every(p => p === "*")) {
    const step = parseInt(parts[0].slice(2));
    if (!isNaN(step)) return Math.max(step * 60000, 60000);
  }
  return null;
}

/** Compute the next run time as ms from now for any supported schedule. */
export function msUntilNextRun(schedule: string, tz?: string): number | null {
  const fixed = getIntervalMs(schedule);
  if (fixed) return fixed;
  return msUntilNextCron(schedule, tz);
}
