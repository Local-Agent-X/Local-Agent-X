import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolResult } from './types.js';

interface CalendarEvent {
  id: string; title: string; start: string; end: string;
  description: string; attendees: string[]; location: string;
}
interface CalendarData { events: CalendarEvent[]; }

const CALENDAR_PATH = join(homedir(), '.sax', 'calendar.json');

async function loadCalendar(): Promise<CalendarData> {
  try {
    const raw = await readFile(CALENDAR_PATH, 'utf-8');
    return JSON.parse(raw) as CalendarData;
  } catch {
    return { events: [] };
  }
}

async function saveCalendar(data: CalendarData): Promise<void> {
  await mkdir(join(homedir(), '.sax'), { recursive: true });
  await writeFile(CALENDAR_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

const ok = (content: string, metadata?: Record<string, unknown>): ToolResult =>
  ({ content, ...(metadata && { metadata }) });
const fail = (content: string): ToolResult => ({ content, isError: true });

// ── Tool 1: calendar_list_events ──

const calendarListEvents: ToolDefinition = {
  name: 'calendar_list_events',
  description:
    'List calendar events in a date range. Example: start_date="2026-04-01", end_date="2026-04-30" returns all April events.',
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
      const cal = await loadCalendar();
      const now = new Date();
      const start = args.start_date ? new Date(args.start_date as string) : now;
      const end = args.end_date ? new Date(args.end_date as string + 'T23:59:59') : null;
      const limit = (args.limit as number) || 20;

      const filtered = cal.events
        .filter((e) => {
          const eStart = new Date(e.start);
          if (eStart < start) return false;
          if (end && eStart > end) return false;
          return true;
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
        .slice(0, limit);

      if (filtered.length === 0) return ok('No events found in the specified range.');
      const lines = filtered.map(
        (e) =>
          `- ${e.title} | ${e.start} → ${e.end}${e.location ? ` @ ${e.location}` : ''}${e.description ? ` — ${e.description}` : ''}`,
      );
      return ok(lines.join('\n'), { count: filtered.length });
    } catch (err) {
      return fail(`Failed to list events: ${(err as Error).message}`);
    }
  },
};

// ── Tool 2: calendar_create_event ──

const calendarCreateEvent: ToolDefinition = {
  name: 'calendar_create_event',
  description:
    'Create a calendar event. Example: title="Team Standup", start="2026-04-02T09:00:00", end="2026-04-02T09:30:00", description="Daily sync"',
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
      const cal = await loadCalendar();
      const attendeeStr = (args.attendees as string) || '';
      const event: CalendarEvent = {
        id: randomUUID(),
        title: args.title as string,
        start: args.start as string,
        end: args.end as string,
        description: (args.description as string) || '',
        attendees: attendeeStr ? attendeeStr.split(',').map((s) => s.trim()) : [],
        location: (args.location as string) || '',
      };
      cal.events.push(event);
      await saveCalendar(cal);
      return ok(`Event created: "${event.title}" (${event.start} → ${event.end}) [id: ${event.id}]`);
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
      const cal = await loadCalendar();

      const dayStart = new Date(`${dateStr}T09:00:00`);
      const dayEnd = new Date(`${dateStr}T17:00:00`);

      const dayEvents = cal.events
        .filter((e) => {
          const eStart = new Date(e.start);
          const eEnd = new Date(e.end);
          return eStart < dayEnd && eEnd > dayStart;
        })
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

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
