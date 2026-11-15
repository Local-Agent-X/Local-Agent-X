// RRULE expansion (RFC 5545 §3.3.10), the parts calendars actually write:
// FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY
// (with an ordinal in a month: 2TU, -1FR), BYMONTHDAY (negative counts from
// the month's end), BYMONTH. Occurrences are generated on the wall clock of
// the event's zone and converted to instants by the caller (ics-time.ts).
// Expansion is bounded: it stops past the window's end, at COUNT or UNTIL, or
// after MAX_STEPS periods, so a malformed or endless rule cannot spin.

import { addDays, daysInMonth, msOf, parseIcsTime, weekday, type IcsTime, type Wall } from "./ics-time.js";

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export const MAX_STEPS = 5000;

interface ByDay { ord: number; wd: number }

export interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  untilMs?: number;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
}

export function parseRule(text: string, zone: string): Rule | null {
  const kv = Object.fromEntries(text.split(";").map((p) => p.split("=") as [string, string]).filter(([k, v]) => k && v));
  const freq = kv.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const until = kv.UNTIL ? parseIcsTime(kv.UNTIL, zone === "local" || zone === "utc" ? {} : { TZID: zone }) : null;
  const byDay = (kv.BYDAY ?? "").split(",").filter(Boolean).map((c) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(c.trim());
    return m ? { ord: m[1] ? Number(m[1]) : 0, wd: DAY_CODES.indexOf(m[2]!) } : null;
  }).filter((b): b is ByDay => b !== null);
  const nums = (s: string | undefined) => (s ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  return {
    freq,
    interval: Math.max(1, Number(kv.INTERVAL) || 1),
    ...(kv.COUNT ? { count: Math.max(1, Number(kv.COUNT)) } : {}),
    ...(until ? { untilMs: until.allDay ? msOf(until) + 86_399_000 : msOf(until) } : {}),
    byDay, byMonthDay: nums(kv.BYMONTHDAY), byMonth: nums(kv.BYMONTH),
  };
}

const withTime = (date: Pick<Wall, "y" | "mo" | "d">, t: Wall): Wall => ({ ...date, h: t.h, mi: t.mi, s: t.s });

/** Days of one month a monthly/yearly rule selects. */
function daysInPeriodMonth(y: number, mo: number, rule: Rule, startDay: number): number[] {
  const last = daysInMonth(y, mo);
  if (rule.byDay.length > 0) {
    const days: number[] = [];
    for (const b of rule.byDay) {
      const matches: number[] = [];
      for (let d = 1; d <= last; d++) if (weekday({ y, mo, d }) === b.wd) matches.push(d);
      if (b.ord === 0) days.push(...matches);
      else { const pick = b.ord > 0 ? matches[b.ord - 1] : matches[matches.length + b.ord]; if (pick) days.push(pick); }
    }
    return days.filter((d) => rule.byMonthDay.length === 0 || rule.byMonthDay.includes(d));
  }
  const wanted = rule.byMonthDay.length > 0 ? rule.byMonthDay : [startDay];
  return wanted.map((d) => (d < 0 ? last + d + 1 : d)).filter((d) => d >= 1 && d <= last);
}

/** The candidate dates of the k-th period, in order. */
function periodDates(start: Wall, rule: Rule, k: number): Wall[] {
  const step = k * rule.interval;
  switch (rule.freq) {
    case "DAILY":
      return [addDays(start, step)];
    case "WEEKLY": {
      const weekStart = addDays(start, -((weekday(start) + 6) % 7) + step * 7); // weeks start Monday
      const wds = rule.byDay.length > 0 ? rule.byDay.map((b) => b.wd) : [weekday(start)];
      return [...new Set(wds)].map((wd) => addDays(weekStart, (wd + 6) % 7)).sort((a, b) => Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(b.y, b.mo - 1, b.d));
    }
    case "MONTHLY": {
      const idx = start.mo - 1 + step;
      const y = start.y + Math.floor(idx / 12);
      const mo = (idx % 12) + 1;
      return daysInPeriodMonth(y, mo, rule, start.d).sort((a, b) => a - b).map((d) => withTime({ y, mo, d }, start));
    }
    case "YEARLY": {
      const y = start.y + step;
      const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [start.mo];
      return months.flatMap((mo) => daysInPeriodMonth(y, mo, rule, start.d).sort((a, b) => a - b).map((d) => withTime({ y, mo, d }, start)));
    }
  }
}

/** Occurrence starts of a recurring event that begin before `toMs` and end
 *  after `fromMs`, as wall-clock times in the event's zone. */
export function expandRule(dtstart: IcsTime, rule: Rule, fromMs: number, toMs: number, durationMs: number): Wall[] {
  const out: Wall[] = [];
  const startMs = msOf(dtstart);
  let produced = 0;
  // With no COUNT to keep, skip the periods wholly before the window (a
  // daily standup since 2015). Each period's length is over-estimated, so
  // the skip never passes an occurrence the window holds.
  const longest = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval * 86_400_000;
  const skip = rule.count === undefined ? Math.max(0, Math.floor((fromMs - durationMs - startMs) / longest) - 1) : 0;
  for (let k = skip; k < skip + MAX_STEPS; k++) {
    const dates = periodDates(dtstart.wall, rule, k);
    if (dates.length === 0) continue;
    for (const wall of dates) {
      if (rule.byMonth.length > 0 && rule.freq !== "YEARLY" && !rule.byMonth.includes(wall.mo)) continue;
      if (rule.freq === "DAILY" && rule.byDay.length > 0 && !rule.byDay.some((b) => b.wd === weekday(wall))) continue;
      const ms = msOf({ ...dtstart, wall });
      if (ms < startMs) continue;
      if (rule.untilMs !== undefined && ms > rule.untilMs) return out;
      produced++;
      if (rule.count !== undefined && produced > rule.count) return out;
      if (ms >= toMs) return out;
      if (ms + durationMs > fromMs) out.push(wall);
    }
  }
  return out;
}
