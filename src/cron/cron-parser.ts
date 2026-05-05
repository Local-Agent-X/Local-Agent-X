// Schedule expression helpers for the cron service.
//
// Supports two forms:
//   - simple intervals: "5m", "1h", "30s", "1d"
//   - 5-field cron expressions: "minute hour dom month dow"
//     with star, "*\/N", "N-M", and "N,M,..." per field.

/** Parse simple interval strings like "5m", "1h", "30s". Returns ms or null. */
export function parseInterval(schedule: string): number | null {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * (multipliers[unit] || 60000);
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

/** Calculate ms until the next cron match. Returns null for non-cron. */
export function msUntilNextCron(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts;

  const now = new Date();
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() + offset * 60_000);
    if (
      cronFieldMatches(minField, candidate.getMinutes(), 59) &&
      cronFieldMatches(hourField, candidate.getHours(), 23) &&
      cronFieldMatches(domField, candidate.getDate(), 31) &&
      cronFieldMatches(monField, candidate.getMonth() + 1, 12) &&
      cronFieldMatches(dowField, candidate.getDay(), 6)
    ) {
      return offset * 60_000;
    }
  }
  return 24 * 3600_000;
}

/** How long ago the most recent matching cron time was. Null if no missed run. */
export function msSinceLastCronOccurrence(schedule: string, lastRun?: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, domField, monField, dowField] = parts;

  const now = new Date();
  for (let offset = 1; offset <= 2880; offset++) {
    const candidate = new Date(now.getTime() - offset * 60_000);
    if (
      cronFieldMatches(minField, candidate.getMinutes(), 59) &&
      cronFieldMatches(hourField, candidate.getHours(), 23) &&
      cronFieldMatches(domField, candidate.getDate(), 31) &&
      cronFieldMatches(monField, candidate.getMonth() + 1, 12) &&
      cronFieldMatches(dowField, candidate.getDay(), 6)
    ) {
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
export function msUntilNextRun(schedule: string): number | null {
  const fixed = getIntervalMs(schedule);
  if (fixed) return fixed;
  return msUntilNextCron(schedule);
}
