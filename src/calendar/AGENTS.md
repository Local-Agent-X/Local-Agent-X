# calendar

**Owns:** Reading the user's time across every calendar they have, as one list: the `CalendarSource` seam each connected calendar implements (`types.ts`), the registry of sources and the merged read `eventsBetween` (`index.ts`), and LAX's own calendar, `<lax data dir>/calendar.json` (`local-store.ts`: the one reader and writer of that file, and the always-present `"lax"` source).
**Does not own:** The calendar tools the model calls (`src/tools/calendar-tools.ts`; they write through `local-store.ts`). Syncing calendar.json between devices (`src/sync/`). A connector's sign-in and credentials (the connector's own module, which registers its source here). What a busy slot means for the user: its readers decide (e.g. `src/server/background-jobs/mail-watch.ts`).
Also owns plans LAX notices on its own (`plans.ts`: a plan is an event in LAX's calendar with an `origin`, chat or mail; `recordPlan` dedupes it and returns what it clashes with on every calendar) and noticing them after a chat turn on any channel (`notice.ts`, called from `src/memory/manager.ts` `persistTurn`; the extraction itself is `src/classifiers/plan-extract.ts`).
**Entry:** `index.ts` — `eventsBetween`, `registerCalendarSource`, `calendarSources`; `local-store.ts` — `loadCalendar`, `saveCalendar`, `localCalendarSource`; `plans.ts` — `recordPlan`, `describeEvent`; `notice.ts` — `noticePlansInTurn`, `announceClash`.

## Adding a calendar connector (Google Calendar, an iCal feed, CalDAV)
1. Implement `CalendarSource` (`kind` `"google"`, `"ics"` or `"caldav"`), read-only: `listEvents(from, to)` returns the events overlapping the window, normalized to `CalendarEvent`, and throws when the calendar cannot be read.
2. Register one source per connected calendar when it connects (`registerCalendarSource`, which returns the removal) and remove it on disconnect.
3. Its network reads go through the guarded egress (`src/tools/web-egress.ts`), and any text from the event that reaches a model goes through `wrapExternalContent()` at the reader.
Nothing that reads the user's time changes when a source is added.

## Readers of the user's time
`src/canonical-loop/turn-loop/coming-up.ts` (the next commitments in every chat's first turn), `src/server/background-jobs/plan-reminders.ts` (reminders), `src/server/background-jobs/mail-watch.ts` (busy awareness, plans from mail), `src/tools/calendar-tools.ts` (list and availability read every calendar; create warns about clashes).

## Invariants
- A plan LAX noticed is recorded only from words the exchange contains verbatim, never a proposal still open, and after a turn that read outside content only from the user's own words (`notice.ts`).
- `eventsBetween` never throws for one source: a source that fails is listed in `unreadable` (and logged), and the others still answer.
- The `"lax"` source is always present.

## Tests
`npx vitest run src/calendar src/tools/calendar-tools` (PowerShell on Windows)
