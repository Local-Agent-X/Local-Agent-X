import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolResult } from '../types.js';
import { recentlyDone, markDone, fingerprintOf, describeAge } from './idempotency.js';
import { loadCalendar, saveCalendar, type StoredCalendarEvent as CalendarEvent } from '../calendar/local-store.js';
import { eventsBetween } from '../calendar/index.js';
import { describeEvent } from '../calendar/plans.js';
import { wrapExternalContent } from '../sanitize.js';

/** Far enough ahead to stand for "no end date" in a listing. */
const LIST_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/** A note naming calendars that could not be read, so a gap is never silent. */
function unreadableNote(unreadable: Array<{ label: string; error: string }>): string {
  return unreadable.length ? `\n(Not readable right now: ${unreadable.map((u) => `${u.label}: ${u.error}`).join('; ')})` : '';
}

// Each call mints a fresh UUID, so two identical-args calls = two
// distinct rows in calendar.json (unlike document_create/pdf_create which
// overwrite by file_path). The 60s within-turn dedup catches the
// MCP-loop case; this 5-min window is the cross-turn / cross-session
// backstop matching the email_send pattern.
const CALENDAR_EVENT_WINDOW_MS = 5 * 60 * 1000;

const ok = (content: string, metadata?: Record<string, unknown>): ToolResult =>
  ({ content, ...(metadata && { metadata }) });
const fail = (content: string): ToolResult => ({ content, isError: true });

// ── Tool 1: calendar_list_events ──

const calendarListEvents: ToolDefinition = {
  name: 'calendar_list_events',
  description:
    'List events from every calendar the user has: LAX\'s own and each connected one (Google Calendar, iCal feeds, CalDAV), plus plans LAX noticed in chats and mail. ' +
    'Example: start_date="2026-04-01", end_date="2026-04-30" returns all April events.',
  parameters: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'ISO date like "2026-04-01" (optional, defaults to today)' },
      end_date: { type: 'string', description: 'ISO date like "2026-04-30" (optional)' },
      limit: { type: 'number', description: 'Max events to return (default 20)' },
    },
  },
  async execute(args) {
    try {
      const now = new Date();
      const start = args.start_date ? new Date(args.start_date as string) : now;
      const end = args.end_date ? new Date(args.end_date as string + 'T23:59:59') : new Date(start.getTime() + LIST_HORIZON_MS);
      const limit = (args.limit as number) || 20;
      const { events, unreadable } = await eventsBetween(start, end);
      const filtered = events.filter((e) => Date.parse(e.start) >= start.getTime()).slice(0, limit);

      if (filtered.length === 0) return ok(`No events found in the specified range.${unreadableNote(unreadable)}`);
      const lines = filtered.map(
        (e) =>
          `- ${e.title} | ${e.start} → ${e.end}${e.location ? ` @ ${e.location}` : ''}${e.description ? ` — ${e.description}` : ''}`
          + `${e.origin ? ` [noticed by LAX in a ${e.origin.kind}]` : ''}${e.sourceId !== 'lax' ? ` [${e.sourceId}]` : ''}`,
      );
      // Titles and notes can come from a connected calendar: outside text.
      return ok(wrapExternalContent(lines.join('\n'), 'calendar') + unreadableNote(unreadable), { count: filtered.length });
    } catch (err) {
      return fail(`Failed to list events: ${(err as Error).message}`);
    }
  },
};

// ── Tool 2: calendar_create_event ──

const calendarCreateEvent: ToolDefinition = {
  name: 'calendar_create_event',
  description:
    'Create an event in LAX\'s own calendar (not in a connected Google, iCal or CalDAV calendar). The result says if it overlaps anything on any of the user\'s calendars. ' +
    'Example: title="Team Standup", start="2026-04-02T09:00:00", end="2026-04-02T09:30:00", description="Daily sync"',
  parameters: {
    type: 'object',
    required: ['title', 'start', 'end'],
    properties: {
      title: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'ISO datetime for event start' },
      end: { type: 'string', description: 'ISO datetime for event end' },
      description: { type: 'string', description: 'Event description (optional)' },
      attendees: { type: 'string', description: 'Comma-separated emails (optional)' },
      location: { type: 'string', description: 'Event location (optional)' },
    },
  },
  async execute(args) {
    try {
      if (!args.title || !args.start || !args.end) {
        return fail('Missing required fields: title, start, and end are required.');
      }
      const title = args.title as string;
      const start = args.start as string;
      const end = args.end as string;
      const description = (args.description as string) || '';
      const attendeeStr = (args.attendees as string) || '';
      const location = (args.location as string) || '';

      const fp = fingerprintOf(title, start, end, description, attendeeStr, location);
      const prior = recentlyDone('calendar_create_event', fp, CALENDAR_EVENT_WINDOW_MS);
      if (prior) {
        return ok(
          `Event "${title}" (${start} → ${end}) was already created ${describeAge(prior.ageMs)} ` +
          `(prior result: ${prior.result}). Skipped this attempt to prevent a duplicate calendar entry. ` +
          `If you genuinely need a second copy, change the title/time or wait a few minutes.`,
          { skipped: 'duplicate', priorResult: prior.result, ageMs: prior.ageMs },
        );
      }

      // What it overlaps on any of the user's calendars: said in the result, so
      // a clash is never created silently, whichever model made the call.
      const { events: around } = await eventsBetween(new Date(start), new Date(end));
      const clashes = around.filter((e) => Date.parse(e.start) < Date.parse(end) && Date.parse(e.end || e.start) > Date.parse(start));
      const cal = await loadCalendar();
      const event: CalendarEvent = {
        id: randomUUID(),
        title,
        start,
        end,
        description,
        attendees: attendeeStr ? attendeeStr.split(',').map((s) => s.trim()) : [],
        location,
      };
      cal.events.push(event);
      await saveCalendar(cal);
      markDone('calendar_create_event', fp, `id=${event.id}`);
      const clashNote = clashes.length > 0
        ? `\nIt overlaps: ${wrapExternalContent(clashes.slice(0, 3).map((c) => describeEvent(c)).join('; '), 'calendar')}\nTell the user about the clash.`
        : '';
      return ok(`Event created: "${event.title}" (${event.start} → ${event.end}) [id: ${event.id}]${clashNote}`, clashes.length ? { clashes: clashes.length } : undefined);
    } catch (err) {
      return fail(`Failed to create event: ${(err as Error).message}`);
    }
  },
};

// ── Tool 3: calendar_check_availability ──

const calendarCheckAvailability: ToolDefinition = {
  name: 'calendar_check_availability',
  description: 'Check available time slots on a given date. Assumes 9am-5pm working hours.',
  parameters: {
    type: 'object',
    required: ['date', 'duration_minutes'],
    properties: {
      date: { type: 'string', description: 'ISO date like "2026-04-01"' },
      duration_minutes: { type: 'number', description: 'Required slot duration in minutes' },
    },
  },
  async execute(args) {
    try {
      if (!args.date || !args.duration_minutes) {
        return fail('Missing required fields: date and duration_minutes.');
      }
      const dateStr = args.date as string;
      const duration = args.duration_minutes as number;
      const dayStart = new Date(`${dateStr}T09:00:00`);
      const dayEnd = new Date(`${dateStr}T17:00:00`);

      // Busy on any of the user's calendars is busy (eventsBetween is sorted).
      const { events: dayEvents } = await eventsBetween(dayStart, dayEnd);

      const slots: string[] = [];
      let cursor = dayStart.getTime();
      const durationMs = duration * 60_000;

      for (const ev of dayEvents) {
        const evStart = new Date(ev.start).getTime();
        const evEnd = new Date(ev.end).getTime();
        const gap = evStart - cursor;
        if (gap >= durationMs) {
          slots.push(`${fmt(cursor)} – ${fmt(evStart)}`);
        }
        cursor = Math.max(cursor, evEnd);
      }
      if (dayEnd.getTime() - cursor >= durationMs) {
        slots.push(`${fmt(cursor)} – ${fmt(dayEnd.getTime())}`);
      }

      if (slots.length === 0) {
        return ok(`No available ${duration}-minute slots on ${dateStr} (9am-5pm).`);
      }
      return ok(
        `Available ${duration}-minute slots on ${dateStr}:\n${slots.map((s) => `- ${s}`).join('\n')}`,
        { count: slots.length },
      );
    } catch (err) {
      return fail(`Failed to check availability: ${(err as Error).message}`);
    }
  },
};

const fmt = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

export const calendarTools: ToolDefinition[] = [
  calendarListEvents,
  calendarCreateEvent,
  calendarCheckAvailability,
];

export function createCalendarTools(): ToolDefinition[] {
  return calendarTools;
}
