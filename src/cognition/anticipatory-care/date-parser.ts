import { DAY_MS } from "./persistence.js";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveRelativeDate(text: string): string | null {
  const lower = text.toLowerCase();
  const now = new Date();

  if (lower.includes("tomorrow")) {
    const d = new Date(now.getTime() + DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  if (lower.includes("today")) {
    return now.toISOString().slice(0, 10);
  }

  if (lower.includes("next week")) {
    const d = new Date(now.getTime() + 7 * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  if (lower.includes("next month")) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  }

  for (let i = 0; i < DAY_NAMES.length; i++) {
    const dayName = DAY_NAMES[i];
    if (lower.includes(dayName) || lower.includes(dayName.slice(0, 3))) {
      const currentDay = now.getDay();
      let daysAhead = i - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      if (lower.includes("next") && daysAhead < 7) daysAhead += 7;
      const d = new Date(now.getTime() + daysAhead * DAY_MS);
      return d.toISOString().slice(0, 10);
    }
  }

  const inDaysMatch = lower.match(/in\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    const d = new Date(now.getTime() + days * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  const inWeeksMatch = lower.match(/in\s+(\d+)\s+weeks?/);
  if (inWeeksMatch) {
    const weeks = parseInt(inWeeksMatch[1], 10);
    const d = new Date(now.getTime() + weeks * 7 * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  return null;
}
