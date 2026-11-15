// What the user taught the mail watcher by rating its alerts, at
// <lax data dir>/mail-ratings.json: per sender and per category, how often an
// alert was worth it and how often it was not. The triage reads it (the model
// sees each sender's record, and a sender rated "not important" twice and
// never "useful" goes to the digest, a travel change excepted); a rating in the
// inbox (inbox:rated) adds to it.
//
// Its own file, written in one synchronous read-modify-write per change, so a
// rating that arrives during a mail pass cannot be lost to the pass's save.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../util/json-store.js";
import { EventBus } from "../../event-bus.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("server.background-jobs.mail-watch-ratings");

export interface Tally { up: number; down: number }

export interface MailRatings {
  senders: Record<string, Tally>;
  categories: Record<string, Tally>;
  /** Alert inbox key → who it was from and what kind, so a rating can be counted. */
  alerts: Record<string, { sender: string; category: string; at: number }>;
}

const MAX_ALERTS = 500;
export const DEMOTE_AFTER = 2;

function path(): string {
  return join(getLaxDir(), "mail-ratings.json");
}

export function loadRatings(): MailRatings {
  try {
    if (!existsSync(path())) return { senders: {}, categories: {}, alerts: {} };
    const raw = JSON.parse(readFileSync(path(), "utf-8")) as Partial<MailRatings>;
    return { senders: raw.senders ?? {}, categories: raw.categories ?? {}, alerts: raw.alerts ?? {} };
  } catch {
    return { senders: {}, categories: {}, alerts: {} };
  }
}

function update(fn: (r: MailRatings) => void): void {
  const r = loadRatings();
  fn(r);
  const kept = Object.entries(r.alerts).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ALERTS);
  atomicWriteFileSync(path(), JSON.stringify({ ...r, alerts: Object.fromEntries(kept) }), { encoding: "utf-8", mode: 0o600 });
}

/** Remember who an alert was from, so its rating can be counted. */
export function noteAlert(key: string, sender: string, category: string, at: number): void {
  update((r) => { r.alerts[key] = { sender, category, at }; });
}

/** Count a rating of an alert. False when the key is not a known alert. */
export function countRating(key: string, rating: "useful" | "not-useful"): boolean {
  let counted = false;
  update((r) => {
    const alert = r.alerts[key];
    if (!alert) return;
    const field = rating === "useful" ? "up" : "down";
    (r.senders[alert.sender] ??= { up: 0, down: 0 })[field]++;
    (r.categories[alert.category] ??= { up: 0, down: 0 })[field]++;
    counted = true;
  });
  return counted;
}

/** True when the user has said this sender's alerts are not worth it. */
export function demoted(r: MailRatings, sender: string): boolean {
  const t = r.senders[sender];
  return !!t && t.down >= DEMOTE_AFTER && t.up === 0;
}

/** "rated useful 1×, not important 2×", or "" for a sender never rated. */
export function senderRecord(r: MailRatings, sender: string): string {
  const t = r.senders[sender];
  if (!t || t.up + t.down === 0) return "";
  return [t.up ? `useful ${t.up}×` : "", t.down ? `not important ${t.down}×` : ""].filter(Boolean).join(", ");
}

/** One line on how the user rated each kind of alert, or "" before any rating. */
export function categoryRecord(r: MailRatings): string {
  const parts = Object.entries(r.categories).filter(([, t]) => t.up + t.down > 0)
    .map(([c, t]) => `${c}: useful ${t.up}×, not important ${t.down}×`);
  return parts.length ? `How the person rated past alerts by kind: ${parts.join("; ")}.` : "";
}

let listening = false;

/** Count every rating of a mail alert. Called once when the runner registers. */
export function listenForRatings(): void {
  if (listening) return;
  listening = true;
  EventBus.on("inbox:rated", ({ key, rating }) => {
    if (!key.startsWith("mail:")) return;
    try { countRating(key, rating); } catch (e) { logger.warn(`[mail-watch] rating not counted: ${(e as Error).message}`); }
  });
}
