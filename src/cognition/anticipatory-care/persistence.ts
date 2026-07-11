import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EventStore } from "./types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { createJsonStore } from "../../util/json-store.js";

const STORE_FILE = join(getLaxDir(), "upcoming-events.json");
const MAX_EVENTS = 500;
export const DAY_MS = 24 * 60 * 60 * 1000;

const store = createJsonStore<EventStore>(STORE_FILE, {
  defaults: () => ({ events: [] }),
});

export function loadStore(): EventStore {
  return store.load();
}

export function saveStore(value: EventStore): void {
  // Cap keeps the newest events BY DATE — a sort-then-head rule the generic
  // json-store cap (positional slice) can't express, so it stays here.
  if (value.events.length > MAX_EVENTS) {
    value.events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    value.events = value.events.slice(0, MAX_EVENTS);
  }
  store.save(value);
}

export function generateId(): string {
  return randomBytes(8).toString("hex");
}

export function parseDate(dateStr: string): number {
  return new Date(dateStr).getTime();
}
