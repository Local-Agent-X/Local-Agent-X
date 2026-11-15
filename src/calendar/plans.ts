// Plans LAX notices on its own: "5:00 with Greg" said in a chat, a dentist
// confirmation in the mail. Each becomes an event in LAX's own calendar
// (local-store.ts), marked with where it came from, so every chat, every
// reminder and every clash check sees it, the same as an event the user made.
//
// Recording a plan also checks it against every calendar the user has
// (eventsBetween): a plan that overlaps another commitment is a clash, which
// the caller tells the user about. That is the Greg/Vic case: the clash is
// caught by LAX whichever chat, channel or day the two plans were made in,
// not only when a model happens to notice both in one conversation.

import { randomUUID } from "node:crypto";
import { eventsBetween } from "./index.js";
import { loadCalendar, saveCalendar, type StoredCalendarEvent } from "./local-store.js";
import type { CalendarEvent, CalendarWindow, PlanOrigin } from "./types.js";

/** How long a plan with no end is taken to last. */
export const DEFAULT_PLAN_MINUTES = 60;

export interface NoticedPlan {
  title: string;
  /** ISO 8601; a local time with no offset is the machine's local time. */
  start: string;
  end?: string;
  where?: string;
  who?: string[];
  origin: Omit<PlanOrigin, "at">;
}

export interface PlanResult {
  /** The event recorded, or null when the same plan was already there. */
  recorded: StoredCalendarEvent | null;
  /** Other commitments it overlaps. */
  clashes: CalendarEvent[];
}

export interface PlanDeps {
  now?: () => Date;
  window?: (from: Date, to: Date) => Promise<CalendarWindow>;
}

/** A start with a date and no time: an all-day event. */
export const isAllDay = (start: string) => /^\d{4}-\d{2}-\d{2}$/.test(start.trim());

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function endOf(plan: Pick<NoticedPlan, "start" | "end">): string {
  const s = Date.parse(plan.start);
  const e = plan.end ? Date.parse(plan.end) : NaN;
  return Number.isFinite(e) && e > s ? plan.end! : new Date(s + DEFAULT_PLAN_MINUTES * 60_000).toISOString();
}

/** True when the stored event is this plan again: same origin and start, or
 *  the same title at the same time from anywhere. */
function samePlan(e: StoredCalendarEvent, plan: NoticedPlan): boolean {
  if (Date.parse(e.start) !== Date.parse(plan.start)) return false;
  if (e.origin && e.origin.kind === plan.origin.kind && e.origin.ref === plan.origin.ref) return true;
  return norm(e.title) === norm(plan.title);
}

/** Record a plan LAX noticed and find what it clashes with. A plan in the
 *  past, or whose time does not parse, is not recorded. */
export async function recordPlan(plan: NoticedPlan, deps: PlanDeps = {}): Promise<PlanResult> {
  const startMs = Date.parse(plan.start);
  const now = (deps.now ?? (() => new Date()))();
  if (!Number.isFinite(startMs) || startMs < now.getTime() - 60 * 60_000) return { recorded: null, clashes: [] };
  const end = endOf(plan);

  const cal = await loadCalendar();
  const already = cal.events.find((e) => samePlan(e, plan));
  const window = await (deps.window ?? eventsBetween)(new Date(startMs), new Date(end));
  const endMs = Date.parse(end);
  const overlaps = (e: CalendarEvent) => Date.parse(e.start) < endMs && Date.parse(e.end || e.start) > startMs;
  // The plan itself, already recorded, or the same plan in a connected calendar.
  const isThisPlan = (e: CalendarEvent) => (already !== undefined && e.sourceId === "lax" && e.id === already.id)
    || (Date.parse(e.start) === startMs && norm(e.title) === norm(plan.title));
  // An all-day event (a holiday, a birthday) does not take the time it spans.
  const clashes = window.events.filter((e) => !isAllDay(e.start) && overlaps(e) && !isThisPlan(e));
  if (already) return { recorded: null, clashes };

  const event: StoredCalendarEvent = {
    id: randomUUID(),
    title: plan.title,
    start: plan.start,
    end,
    description: "",
    attendees: plan.who ?? [],
    location: plan.where ?? "",
    origin: { ...plan.origin, at: now.getTime() },
  };
  cal.events.push(event);
  await saveCalendar(cal);
  return { recorded: event, clashes };
}

/** "Dinner with Greg (Fri 5:00 PM)": how a plan or event is named to the user. */
export function describeEvent(e: { title: string; start: string }): string {
  const d = new Date(e.start);
  if (!Number.isFinite(d.getTime())) return e.title;
  const when = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${e.title} (${when})`;
}
