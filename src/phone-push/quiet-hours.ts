// Quiet hours: the stretch of the night when a phone alert waits instead of
// ringing. Each user sets them (Settings → General → Watching for you; on by
// default, 22:00-07:00 local time). An alert raised inside them is held here,
// on disk so a restart does not lose it, and all held alerts go out when they
// end. The inbox itself is never held: only the phone's ring waits.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import type { InboxItem } from "../inbox/types.js";

export interface QuietHoursConfig {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

/** Minutes after midnight for "HH:MM", or null when it is not one. */
export function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * When the quiet hours `now` falls in end, or null when `now` is outside them
 * (or they are off, or empty, or misconfigured). Local time; a window whose
 * start is after its end runs over midnight.
 */
export function quietUntil(now: Date, cfg: QuietHoursConfig): Date | null {
  if (!cfg.quietHoursEnabled) return null;
  const start = minutesOf(cfg.quietHoursStart);
  const end = minutesOf(cfg.quietHoursEnd);
  if (start === null || end === null || start === end) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const inside = start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
  if (!inside) return null;
  const until = new Date(now);
  until.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (until.getTime() <= now.getTime()) until.setDate(until.getDate() + 1);
  return until;
}

/** Alerts held for the end of quiet hours, newest last. Kept to the most
 *  recent MAX_HELD: every one of them is still in the inbox. */
export const MAX_HELD = 10;

export interface HeldAlerts {
  list(): InboxItem[];
  add(item: InboxItem): void;
  /** Everything held, emptied in the same step. */
  take(): InboxItem[];
}

function heldPath(): string {
  return join(getLaxDir(), "phone-push-held.json");
}

function read(path: string): InboxItem[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((i): i is InboxItem => !!i && typeof (i as InboxItem).id === "string") : [];
  } catch {
    return [];
  }
}

/** Held alerts at <lax data dir>/phone-push-held.json. */
export function heldAlerts(path: string = heldPath()): HeldAlerts {
  const write = (items: InboxItem[]) => atomicWriteFileSync(path, JSON.stringify(items), { encoding: "utf-8", mode: 0o600 });
  return {
    list: () => read(path),
    add: (item) => {
      const items = read(path).filter((i) => i.id !== item.id);
      items.push(item);
      write(items.slice(-MAX_HELD));
    },
    take: () => {
      const items = read(path);
      if (items.length > 0) write([]);
      return items;
    },
  };
}
