// The two kinds of connected calendar, each a CalendarSource (../types.ts):
//
//  - An iCal feed: a private .ics link. Google Calendar's "secret address in
//    iCal format", an iCloud public calendar, an Outlook published calendar.
//    Read-only, no sign-in: the link is the credential, so it lives in the
//    vault, never in a config file or a log.
//  - CalDAV: a calendar collection URL with a username and an app password
//    (iCloud, Fastmail, Nextcloud). One REPORT calendar-query asks the server
//    for the window's events, already expanded where it can.
//
// Both go through the guarded egress (canonicalFetch: DNS pinning, private-IP
// block, the user's strict-mode allowlist, redirect re-checks), are refused in
// strict local-only mode, keep at most MAX_BYTES of a reply, and cache a feed
// for a few minutes so a turn, a reminder pass and a mail pass in the same
// minute fetch it once.

import { canonicalFetch } from "../../tools/web-egress.js";
import { isLocalOnlyMode } from "../../local-only-policy.js";
import type { CalendarEvent, CalendarSource } from "../types.js";
import { parseIcs } from "./ics.js";

export const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export interface FetchText {
  (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }>;
}

/** canonicalFetch, the body read to at most MAX_BYTES. */
export const guardedFetchText: FetchText = async (url, init) => {
  const r = await canonicalFetch(url, { ...init, timeoutMs: TIMEOUT_MS, maxRedirects: 3 });
  const reader = r.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error(`the calendar is larger than ${MAX_BYTES / 1024 / 1024} MB`); }
      chunks.push(value);
    }
  }
  return { status: r.status, text: Buffer.concat(chunks).toString("utf-8") };
};

/** webcal:// is https:// as far as fetching goes. */
export function feedUrl(url: string): string {
  return url.trim().replace(/^webcals?:\/\//i, "https://");
}

function refuseLocalOnly(): void {
  if (isLocalOnlyMode()) throw new Error("strict local-only mode is on, so connected calendars are not read");
}

export function icsFeedSource(cfg: { id: string; label: string; url: () => string | undefined; fetch?: FetchText }): CalendarSource {
  let cache: { at: number; text: string } | null = null;
  return {
    id: cfg.id, kind: "ics", label: cfg.label,
    async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
      refuseLocalOnly();
      if (!cache || Date.now() - cache.at > CACHE_MS) {
        const url = cfg.url();
        if (!url) throw new Error("its link is no longer in the vault; connect it again in Settings");
        const r = await (cfg.fetch ?? guardedFetchText)(feedUrl(url), { headers: { Accept: "text/calendar, */*" } });
        if (r.status !== 200) throw new Error(`the calendar server answered ${r.status}`);
        if (!/BEGIN:VCALENDAR/i.test(r.text)) throw new Error("the link did not return a calendar (.ics)");
        cache = { at: Date.now(), text: r.text };
      }
      return parseIcs(cache.text, from.getTime(), to.getTime(), cfg.id);
    },
  };
}

/** "20261114T170000Z" for a CalDAV time-range. */
function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

/** The iCalendar text of each event in a CalDAV multistatus reply. */
export function calendarDataOf(multistatus: string): string[] {
  return [...multistatus.matchAll(/<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/gi)].map((m) => unxml(m[1]!));
}

export function caldavSource(cfg: {
  id: string; label: string; url: string; username: string; password: () => string | undefined; fetch?: FetchText;
}): CalendarSource {
  return {
    id: cfg.id, kind: "caldav", label: cfg.label,
    async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
      refuseLocalOnly();
      const password = cfg.password();
      if (!password) throw new Error("its password is no longer in the vault; connect it again in Settings");
      const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${utcStamp(from)}" end="${utcStamp(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
      const r = await (cfg.fetch ?? guardedFetchText)(cfg.url, {
        method: "REPORT",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.username}:${password}`).toString("base64")}`,
          Depth: "1",
          "Content-Type": "application/xml; charset=utf-8",
        },
        body,
      });
      if (r.status === 401 || r.status === 403) throw new Error("the server refused the username or app password");
      if (r.status !== 207 && r.status !== 200) throw new Error(`the calendar server answered ${r.status}`);
      return calendarDataOf(r.text)
        .flatMap((ics) => parseIcs(ics, from.getTime(), to.getTime(), cfg.id))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    },
  };
}
