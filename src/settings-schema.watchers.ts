/**
 * The settings for what LAX watches on the user's behalf without being asked:
 * the mail watcher (src/server/background-jobs/mail-watch.ts) and the quiet
 * hours every phone alert respects (src/phone-push/quiet-hours.ts). Each is a
 * per-user choice with a default; all are read by the server runtime.
 *
 * Part of FLIPPABLE_SETTINGS (settings-schema.ts).
 */
import { z } from "zod";
import type { FlippableSetting } from "./settings-schema.js";

const WATCHING = "Settings → General → Watching for you";
const HH_MM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const WATCHER_SETTINGS: ReadonlyArray<FlippableSetting> = [
  {
    field: "mailWatchEnabled",
    owner: "protected", where: WATCHING,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Read new mail in the background about every 15 minutes and raise the important messages (jobs and business, people the user has written to, deadlines and money, travel changes, appointments, changes to their accounts, failures in what they run) in the inbox and on the phone; the rest roll into one digest each morning. On by default; does nothing until an email account is set up. Read-only: it never sends, moves or deletes mail",
  },
  {
    field: "mailWatchLocalOnly",
    owner: "protected", where: WATCHING,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Triage mail with a model on this machine only, so no email text goes to a cloud model. Off (default) uses the chat model. When no local model is available the mail check is skipped and the inbox says so; it never falls back to the cloud",
  },
  {
    field: "quietHoursEnabled",
    owner: "agent",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Hold phone alerts during quiet hours and deliver them when quiet hours end. Travel changes still come through. On by default",
  },
  {
    field: "quietHoursStart",
    owner: "agent",
    validate: HH_MM,
    runtime: true,
    broadcast: true,
    description: "When quiet hours begin, local time \"HH:MM\" (default 22:00)",
  },
  {
    field: "quietHoursEnd",
    owner: "agent",
    validate: HH_MM,
    runtime: true,
    broadcast: true,
    description: "When quiet hours end and held phone alerts are delivered, local time \"HH:MM\" (default 07:00). Also when the daily mail digest is posted",
  },
];
