// Connected calendars: an iCal link and a CalDAV account read through a fake
// network, checked before they are saved, credentials only in the vault, and
// gone (source and secret) on disconnect.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsStore, setSecretsStoreSingleton } from "../../secrets.js";
import { calendarSources, eventsBetween } from "../index.js";
import { connectCalendar, disconnectCalendar, listConnected } from "./store.js";
import { calendarDataOf, feedUrl, type FetchText } from "./sources.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
let vault: SecretsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-cal-connect-"));
  process.env.LAX_DATA_DIR = dir;
  vault = new SecretsStore(dir);
  setSecretsStoreSingleton(vault);
});
afterEach(() => {
  for (const c of listConnected()) disconnectCalendar(c.id);
  setSecretsStoreSingleton(null as unknown as SecretsStore);
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date("2026-11-14T10:00:00Z");
const ICS = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "SUMMARY:Dentist", "DTSTART:20261118T150000Z", "DURATION:PT1H", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

describe("an iCal link (Google's secret address, iCloud, Outlook)", () => {
  it("is checked, its link kept only in the vault, and its events join every calendar read", async () => {
    const fetch: FetchText = vi.fn(async () => ({ status: 200, text: ICS }));
    const r = await connectCalendar({ kind: "ics", label: "Personal", url: "webcal://calendar.google.com/private-abc/basic.ics" }, { fetch, now });
    expect(r).toMatchObject({ ok: true, events: 1 });
    expect(fetch).toHaveBeenCalledWith("https://calendar.google.com/private-abc/basic.ics", expect.anything());
    const file = readFileSync(join(dir, "calendars.json"), "utf-8");
    expect(file).not.toContain("private-abc");
    const saved = listConnected()[0]!;
    expect(vault.get(saved.urlSecret!)).toBe("https://calendar.google.com/private-abc/basic.ics");
    const { events } = await eventsBetween(now(), new Date("2026-11-30T00:00:00Z"));
    expect(events.map((e) => e.title)).toContain("Dentist");
  });

  it("is not saved when the link does not return a calendar", async () => {
    const fetch: FetchText = async () => ({ status: 200, text: "<html>sign in</html>" });
    const r = await connectCalendar({ kind: "ics", label: "x", url: "https://example.com/cal" }, { fetch, now });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("did not return a calendar") });
    expect(listConnected()).toEqual([]);
  });

  it("disconnecting removes the source and deletes the link from the vault", async () => {
    const fetch: FetchText = async () => ({ status: 200, text: ICS });
    const r = await connectCalendar({ kind: "ics", label: "Personal", url: "https://x.example/a.ics" }, { fetch, now });
    const id = (r as { calendar: { id: string; urlSecret: string } }).calendar.id;
    const secret = listConnected()[0]!.urlSecret!;
    expect(calendarSources().some((s) => s.id === id)).toBe(true);
    expect(disconnectCalendar(id)).toBe(true);
    expect(calendarSources().some((s) => s.id === id)).toBe(false);
    expect(vault.get(secret)).toBeUndefined();
  });
});

describe("CalDAV (iCloud, Fastmail, Nextcloud)", () => {
  const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response><d:propstat><d:prop><cal:calendar-data>${ICS.replace(/&/g, "&amp;")}</cal:calendar-data></d:prop></d:propstat></d:response>
</d:multistatus>`;

  it("asks for the window with a REPORT, authenticated, and reads the events", async () => {
    const fetch = vi.fn(async (_url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      expect(init.method).toBe("REPORT");
      expect(init.headers?.Authorization).toBe(`Basic ${Buffer.from("me@icloud.com:app-pass").toString("base64")}`);
      expect(init.body).toContain('time-range start="20261114T100000Z"');
      return { status: 207, text: multistatus };
    });
    const r = await connectCalendar({ kind: "caldav", label: "iCloud", url: "https://caldav.icloud.com/123/calendars/home/", username: "me@icloud.com", password: "app-pass" }, { fetch, now });
    expect(r).toMatchObject({ ok: true, events: 1 });
    expect(readFileSync(join(dir, "calendars.json"), "utf-8")).not.toContain("app-pass");
  });

  it("says a refused password plainly and saves nothing", async () => {
    const r = await connectCalendar({ kind: "caldav", label: "x", url: "https://dav.example/cal/", username: "me", password: "bad" }, { fetch: async () => ({ status: 401, text: "" }), now });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("refused the username or app password") });
    expect(listConnected()).toEqual([]);
  });

  it("reads calendar-data under any namespace prefix, CDATA included", () => {
    expect(calendarDataOf("<C:calendar-data><![CDATA[BEGIN:VCALENDAR]]></C:calendar-data><calendar-data>a &amp; b</calendar-data>")).toEqual(["BEGIN:VCALENDAR", "a & b"]);
    expect(feedUrl("webcals://p.icloud.com/x")).toBe("https://p.icloud.com/x");
  });
});
