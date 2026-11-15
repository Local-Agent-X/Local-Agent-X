// The user's next few commitments, as one line of the situational digest
// (situational-awareness.ts), on a request's first turn.
//
// Read from every calendar the user has (src/calendar/, plans LAX noticed in
// chats and mail included), so a chat on any channel knows that 5:00 is taken
// before it proposes or accepts 5:00, whichever chat or day the first plan
// was made in. Two commitments that already overlap are marked, so the agent
// can say so. Titles can come from a connected calendar or a mail, so the
// list is fenced as external content.

import { wrapExternalContent } from "../../sanitize.js";

/** How far ahead a chat is told about. */
export const COMING_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
export const COMING_UP_CAP = 6;

export interface UpcomingEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  sourceId: string;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : iso;
}

const overlap = (a: UpcomingEvent, b: UpcomingEvent) =>
  Date.parse(a.start) < Date.parse(b.end || b.start) && Date.parse(b.start) < Date.parse(a.end || a.start);

/** The digest line, or null when nothing is coming up. */
export function comingUpLine(events: readonly UpcomingEvent[]): string | null {
  const shown = events.slice(0, COMING_UP_CAP);
  if (shown.length === 0) return null;
  const lines = shown.map((e, i) => {
    const clash = shown.find((o, j) => j !== i && overlap(e, o));
    return `- ${when(e.start)}: ${e.title}${e.location ? ` @ ${e.location}` : ""}${clash ? ` (OVERLAPS ${clash.title})` : ""}`;
  });
  const more = events.length > shown.length ? `\n…and ${events.length - shown.length} more in the next 48 hours.` : "";
  return [
    "The user's commitments in the next 48 hours, from all their calendars (calendar_list_events has the rest).",
    "Before you propose, accept or book a time for them, check it against these; if it clashes, say so first.",
    wrapExternalContent(lines.join("\n") + more, "calendar"),
  ].join("\n");
}
