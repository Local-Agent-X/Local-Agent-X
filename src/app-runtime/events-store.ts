import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { eventsPath } from "./paths.js";
import type { RateLimiter } from "./rate-limiter.js";
import { type AppEvent, MAX_EVENTS_STORED } from "./types.js";
import { readState, writeState } from "./state-store.js";

export function readEvents(id: string, since?: number): AppEvent[] {
  const p = eventsPath(id);
  if (!existsSync(p)) return [];
  try {
    const events: AppEvent[] = JSON.parse(readFileSync(p, "utf-8"));
    if (since) return events.filter(e => e.timestamp > since);
    return events;
  } catch { return []; }
}

export function pushEvent(
  id: string,
  event: Omit<AppEvent, "id" | "timestamp" | "consumed">,
  limiter: RateLimiter,
): { event?: AppEvent; error?: string } {
  if (!limiter.check(`event:${id}`)) {
    return { error: "Rate limit exceeded for events" };
  }

  const full: AppEvent = {
    ...event,
    id: `evt_${Date.now()}_${randomBytes(4).toString("hex")}`,
    timestamp: Date.now(),
    consumed: false,
  };
  const events = readEvents(id);
  events.push(full);
  const trimmed = events.length > MAX_EVENTS_STORED ? events.slice(-MAX_EVENTS_STORED) : events;
  writeFileSync(eventsPath(id), JSON.stringify(trimmed, null, 2), "utf-8");

  const state = readState(id);
  if (state) {
    state.metadata.lastUserUpdate = Date.now();
    writeState(id, state);
  }

  return { event: full };
}

export function consumeEvents(id: string, eventIds: string[]): void {
  const events = readEvents(id);
  const idSet = new Set(eventIds);
  for (const e of events) {
    if (idSet.has(e.id)) e.consumed = true;
  }
  writeFileSync(eventsPath(id), JSON.stringify(events, null, 2), "utf-8");
}

export function getUnconsumedEvents(id: string): AppEvent[] {
  return readEvents(id).filter(e => !e.consumed);
}
