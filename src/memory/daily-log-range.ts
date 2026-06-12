import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Reads the daily-log files (YYYY-MM-DD.md) that back "what did we do on
// <date>" queries. recallByTime (index-facts.ts) only queries the extracted
// Facts DB by timestamp, so a day that has a daily log but no date-stamped
// facts comes back empty — the exact failure where the agent says "I have no
// memory of that day" while 2026-04-16.md sits right there. memory_recall's
// date-window branch combines facts WITH these logs so the day's real record
// always surfaces.

export interface DailyLogEntry {
  date: string;
  content: string;
  truncated: boolean;
}

interface RangeOpts {
  /** Hard cap on days scanned, so a year-wide range can't walk the whole store. */
  maxDays?: number;
  /** Per-day char cap; the full file is still reachable via memory_get. */
  maxCharsPerDay?: number;
  /** Total char budget across all days returned. */
  maxTotalChars?: number;
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Read existing daily-log files in [since, until] (inclusive, UTC days).
 * `until` defaults to `since` (single-day lookup). Returns oldest→newest,
 * skipping dates with no file or an empty file. Bounded by the opts caps.
 */
export function readDailyLogsInRange(
  memoryDir: string,
  since: Date,
  until?: Date,
  opts: RangeOpts = {},
): DailyLogEntry[] {
  const maxDays = opts.maxDays ?? 31;
  const maxCharsPerDay = opts.maxCharsPerDay ?? 12_000;
  const maxTotalChars = opts.maxTotalChars ?? 30_000;

  const start = utcDayStart(since);
  const end = utcDayStart(until ?? since);
  if (end.getTime() < start.getTime()) return [];

  const entries: DailyLogEntry[] = [];
  let total = 0;
  let days = 0;

  for (
    let d = start;
    d.getTime() <= end.getTime() && days < maxDays && total < maxTotalChars;
    d = new Date(d.getTime() + 86_400_000)
  ) {
    days++;
    const date = isoDate(d);
    const path = join(memoryDir, `${date}.md`);
    if (!existsSync(path)) continue;

    let content = readFileSync(path, "utf-8").trim();
    if (!content) continue;

    let truncated = false;
    if (content.length > maxCharsPerDay) {
      content = content.slice(0, maxCharsPerDay);
      truncated = true;
    }
    const remaining = maxTotalChars - total;
    if (content.length > remaining) {
      content = content.slice(0, Math.max(0, remaining));
      truncated = true;
    }
    entries.push({ date, content, truncated });
    total += content.length;
  }

  return entries;
}

/**
 * List existing daily-log dates within `windowDays` of `target` (inclusive),
 * sorted oldest→newest. Used to give an HONEST answer when the asked date has
 * no log — "nothing logged May 9; nearest records: May 7, May 11" — instead of
 * silence (which reads as broken) or a confabulated day.
 */
export function listNearbyDailyLogDates(
  memoryDir: string,
  target: Date,
  windowDays = 10,
): string[] {
  const targetMs = utcDayStart(target).getTime();
  const span = windowDays * 86_400_000;
  let files: string[];
  try {
    files = readdirSync(memoryDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.slice(0, 10))
    .filter((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - targetMs) <= span)
    .sort();
}
