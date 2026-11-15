// The calendars a user connected, at <lax data dir>/calendars.json, and their
// registration as calendar sources (../index.ts registerCalendarSource).
//
// The file holds no credential: an iCal link and a CalDAV password live in the
// vault under the names recorded here. Connecting checks the calendar answers
// before anything is saved, so a wrong link or password is said at once, not
// discovered later as a missing calendar.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../util/json-store.js";
import { getSecretsStoreSingleton } from "../../secrets.js";
import { createLogger } from "../../logger.js";
import { registerCalendarSource } from "../index.js";
import type { CalendarSource } from "../types.js";
import { caldavSource, feedUrl, icsFeedSource, type FetchText } from "./sources.js";

const logger = createLogger("calendar.connectors");

export interface ConnectedCalendar {
  id: string;
  kind: "ics" | "caldav";
  label: string;
  /** ics: the vault name of the feed link. */
  urlSecret?: string;
  /** caldav: the collection URL (not a credential), user and the password's vault name. */
  url?: string;
  username?: string;
  passwordSecret?: string;
  addedAt: number;
}

export type ConnectRequest =
  | { kind: "ics"; label: string; url: string }
  | { kind: "caldav"; label: string; url: string; username: string; password: string };

function path(): string {
  return join(getLaxDir(), "calendars.json");
}

export function listConnected(): ConnectedCalendar[] {
  try {
    if (!existsSync(path())) return [];
    const parsed = JSON.parse(readFileSync(path(), "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ConnectedCalendar[]).filter((c) => c && typeof c.id === "string") : [];
  } catch {
    return [];
  }
}

function save(list: ConnectedCalendar[]): void {
  atomicWriteFileSync(path(), JSON.stringify(list, null, 2), { encoding: "utf-8", mode: 0o600 });
}

const vault = () => getSecretsStoreSingleton();

function sourceOf(c: ConnectedCalendar, fetch?: FetchText): CalendarSource | null {
  if (c.kind === "ics" && c.urlSecret) {
    return icsFeedSource({ id: c.id, label: c.label, url: () => vault()?.get(c.urlSecret!), ...(fetch ? { fetch } : {}) });
  }
  if (c.kind === "caldav" && c.url && c.username && c.passwordSecret) {
    return caldavSource({ id: c.id, label: c.label, url: c.url, username: c.username, password: () => vault()?.get(c.passwordSecret!), ...(fetch ? { fetch } : {}) });
  }
  return null;
}

const removals = new Map<string, () => void>();

function register(c: ConnectedCalendar, fetch?: FetchText): void {
  const source = sourceOf(c, fetch);
  if (!source) return;
  removals.get(c.id)?.();
  removals.set(c.id, registerCalendarSource(source));
}

/** Register every connected calendar. Called once at boot. */
export function startCalendarConnectors(): void {
  for (const c of listConnected()) register(c);
}

export type ConnectResult = { ok: true; calendar: ConnectedCalendar; events: number } | { ok: false; error: string };

/** Check the calendar answers, then store its credential in the vault and
 *  register it. Nothing is saved when the check fails. */
export async function connectCalendar(req: ConnectRequest, deps: { fetch?: FetchText; now?: () => Date } = {}): Promise<ConnectResult> {
  const label = req.label.trim().slice(0, 60) || (req.kind === "ics" ? "iCal calendar" : "CalDAV calendar");
  let url: URL;
  try { url = new URL(feedUrl(req.url)); } catch { return { ok: false, error: "That is not a web address." }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The address must start with https:// or webcal://." };
  if (req.kind === "caldav" && (!req.username.trim() || !req.password)) return { ok: false, error: "CalDAV needs a username and an app password." };
  const store = vault();
  if (!store) return { ok: false, error: "The secrets vault is not available." };

  const id = `${req.kind}:${randomBytes(6).toString("hex")}`;
  const secretBase = `CALENDAR_${id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
  const draft: ConnectedCalendar = req.kind === "ics"
    ? { id, kind: "ics", label, urlSecret: `${secretBase}_URL`, addedAt: Date.now() }
    : { id, kind: "caldav", label, url: url.toString(), username: req.username.trim(), passwordSecret: `${secretBase}_PASSWORD`, addedAt: Date.now() };
  const secretValue = req.kind === "ics" ? url.toString() : req.password;
  const probe = req.kind === "ics"
    ? icsFeedSource({ id, label, url: () => secretValue, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    : caldavSource({ id, label, url: url.toString(), username: req.username.trim(), password: () => secretValue, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const now = (deps.now ?? (() => new Date()))();
  let events: number;
  try {
    events = (await probe.listEvents(now, new Date(now.getTime() + 30 * 86_400_000))).length;
  } catch (e) {
    return { ok: false, error: `Couldn't read that calendar: ${(e as Error).message}` };
  }
  store.set(req.kind === "ics" ? draft.urlSecret! : draft.passwordSecret!, secretValue, { service: "calendar", notes: `Connected calendar "${label}"`, url: url.origin });
  save([...listConnected(), draft]);
  register(draft, deps.fetch);
  logger.info(`[calendar] connected ${draft.kind} calendar "${label}" (${events} events in the next 30 days)`);
  return { ok: true, calendar: draft, events };
}

/** Disconnect a calendar: unregister it and delete its credential. */
export function disconnectCalendar(id: string): boolean {
  const list = listConnected();
  const c = list.find((x) => x.id === id);
  if (!c) return false;
  removals.get(id)?.();
  removals.delete(id);
  const secret = c.urlSecret ?? c.passwordSecret;
  if (secret) vault()?.delete(secret);
  save(list.filter((x) => x.id !== id));
  return true;
}

/** What a client may see: never a secret, nor the vault's names for them. */
export function connectedView(c: ConnectedCalendar): { id: string; kind: string; label: string; username?: string; host?: string; addedAt: number } {
  let host: string | undefined;
  try { host = c.url ? new URL(c.url).host : undefined; } catch { host = undefined; }
  return { id: c.id, kind: c.kind, label: c.label, ...(c.username ? { username: c.username } : {}), ...(host ? { host } : {}), addedAt: c.addedAt };
}
