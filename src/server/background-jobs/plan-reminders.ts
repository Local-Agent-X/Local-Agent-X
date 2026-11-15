/**
 * Reminders before commitments: every few minutes, anything on any of the
 * user's calendars (connected ones, LAX's own, plans LAX noticed in chats and
 * mail) that starts within their lead time is posted to the inbox, which
 * rings the phone (quiet hours permitting, src/phone-push/).
 *
 * One reminder per event occurrence: its inbox key names the calendar, the
 * event and its start, so a later pass finds it already posted, and a moved
 * event is reminded about at its new time. All-day events (a date with no
 * time) get none. Lead time is the user's setting (remindBeforeMinutes,
 * default 30; 0 is off).
 */
import { getRuntimeConfig } from "../../config.js";
import { eventsBetween, type CalendarWindow } from "../../calendar/index.js";
import { inboxPlanReminder } from "../../inbox/producers.js";

export const PLAN_REMINDER_INTERVAL_MS = 5 * 60 * 1000;

export interface PlanReminderDeps {
  now?: () => Date;
  window?: (from: Date, to: Date) => Promise<CalendarWindow>;
  post?: typeof inboxPlanReminder;
  leadMinutes?: () => number;
}

/** A date with no time ("2026-11-14") is an all-day event. */
const isAllDay = (start: string) => /^\d{4}-\d{2}-\d{2}$/.test(start.trim());

function at(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Post the reminders due now; returns how many were new. */
export async function runPlanReminderPass(deps: PlanReminderDeps = {}): Promise<number> {
  const lead = (deps.leadMinutes ?? (() => getRuntimeConfig().remindBeforeMinutes))();
  if (!lead || lead <= 0) return 0;
  const now = (deps.now ?? (() => new Date()))();
  const until = new Date(now.getTime() + lead * 60_000);
  const { events } = await (deps.window ?? eventsBetween)(now, until);
  let posted = 0;
  for (const e of events) {
    const start = Date.parse(e.start);
    if (isAllDay(e.start) || !Number.isFinite(start) || start <= now.getTime() || start > until.getTime()) continue;
    const ok = (deps.post ?? inboxPlanReminder)({
      key: `reminder:${e.sourceId}:${e.id}:${start}`,
      title: `At ${at(e.start)}: ${e.title}`,
      body: `${e.title} starts at ${at(e.start)}${e.location ? ` at ${e.location}` : ""}.`,
    });
    if (ok) posted++;
  }
  return posted;
}
