// What the travel watcher remembers between passes, at
// <lax data dir>/travel-watch.json: each flight's last lookup and status
// (keyed by flight number and scheduled departure), and today's lookup count.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { atomicWriteFileSync } from "../../util/json-store.js";
import type { FlightStatus } from "./travel-watch-prompt.js";

export interface TravelState {
  flights: Record<string, { checkedAt: number; last?: FlightStatus }>;
  usage: { day: string; lookups: number };
}

const empty = (): TravelState => ({ flights: {}, usage: { day: "", lookups: 0 } });

function statePath(): string {
  return join(getLaxDir(), "travel-watch.json");
}

export function loadTravelState(path: string = statePath()): TravelState {
  try {
    if (!existsSync(path)) return empty();
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TravelState>;
    return {
      flights: raw.flights && typeof raw.flights === "object" ? raw.flights : {},
      usage: raw.usage && typeof raw.usage.day === "string" ? raw.usage : { day: "", lookups: 0 },
    };
  } catch {
    return empty();
  }
}

export function saveTravelState(state: TravelState, path: string = statePath()): void {
  atomicWriteFileSync(path, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
}
