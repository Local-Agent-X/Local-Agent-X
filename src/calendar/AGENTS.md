# calendar

**Owns:** Reading the user's time across every calendar they have, as one list: the `CalendarSource` seam each connected calendar implements (`types.ts`), the registry of sources and the merged read `eventsBetween` (`index.ts`), and LAX's own calendar, `<lax data dir>/calendar.json` (`local-store.ts`: the one reader and writer of that file, and the always-present `"lax"` source).
**Does not own:** The calendar tools the model calls (`src/tools/calendar-tools.ts`; they write through `local-store.ts`). Syncing calendar.json between devices (`src/sync/`). A connector's sign-in and credentials (the connector's own module, which registers its source here). What a busy slot means for the user: its readers decide (e.g. `src/server/background-jobs/mail-watch.ts`).
**Entry:** `index.ts` — `eventsBetween`, `registerCalendarSource`, `calendarSources`; `local-store.ts` — `loadCalendar`, `saveCalendar`, `localCalendarSource`.

## Adding a calendar connector (Google Calendar, an iCal feed, CalDAV)
1. Implement `CalendarSource` (`kind` `"google"`, `"ics"` or `"caldav"`), read-only: `listEvents(from, to)` returns the events overlapping the window, normalized to `CalendarEvent`, and throws when the calendar cannot be read.
2. Register one source per connected calendar when it connects (`registerCalendarSource`, which returns the removal) and remove it on disconnect.
3. Its network reads go through the guarded egress (`src/tools/web-egress.ts`), and any text from the event that reaches a model goes through `wrapExternalContent()` at the reader.
Nothing that reads the user's time changes when a source is added.

## Invariants
- `eventsBetween` never throws for one source: a source that fails is listed in `unreadable` (and logged), and the others still answer.
- The `"lax"` source is always present.

## Tests
`npx vitest run src/calendar src/tools/calendar-tools` (PowerShell on Windows)
