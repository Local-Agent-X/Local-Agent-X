/**
 * Travel watch — "your flight's delayed", unprompted.
 *
 * Flights come from the user's calendars (src/calendar/): a connected one, or
 * a plan the mail watcher recorded from an itinerary or booking mail. From a
 * day before departure, a short lookup run with only the read-only web tools
 * (web search, page fetch, through the guarded egress) reads the flight's live
 * status; a delay, cancellation, diversion, a new departure time or a gate
 * change is raised in the inbox and rings the phone, quiet hours or not.
 *
 * What bounds it: lookups at about 24 h and 6 h out, hourly from 6 h, every
 * 20 minutes in the last 3 h, none after departure (or once it has left);
 * DAILY_LOOKUP_CAP a day; a per-user switch (travelWatchEnabled, on by
 * default); nothing in strict local-only mode, where the web tools are off.
 */
import { getRuntimeConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { OP_TYPE } from "../../ops/op-types.js";
import { isLocalOnlyMode } from "../../local-only-policy.js";
import { eventsBetween, type CalendarWindow } from "../../calendar/index.js";
import { inboxTravelChange } from "../../inbox/producers.js";
import { forkReply, reviewFailure, runReviewFork, type ReviewForkDeps } from "./review-fork.js";
import type { ToolDefinition } from "../../types.js";
import {
  TRAVEL_WATCH_SESSION_PREFIX, TRAVEL_WATCH_SYSTEM_PROMPT, buildTravelLookupMessage, changeOf, flightNumberOf, parseFlightStatus,
} from "./travel-watch-prompt.js";
import { loadTravelState, saveTravelState, type TravelState } from "./travel-watch-state.js";

const logger = createLogger("server.background-jobs.travel-watch");

export const TRAVEL_WATCH_INTERVAL_MS = 10 * 60 * 1000;
export const DAILY_LOOKUP_CAP = 40;
const HOUR = 60 * 60 * 1000;

export interface TravelWatchDeps extends ReviewForkDeps {
  /** The read-only web tools the lookup run may use. */
  webTools: () => ToolDefinition[];
  now?: () => Date;
  window?: (from: Date, to: Date) => Promise<CalendarWindow>;
  runFork?: typeof runReviewFork;
  statePath?: string;
}

let deps: TravelWatchDeps | null = null;
export function registerTravelWatchRunner(next: TravelWatchDeps): void { deps = next; }

/** How long to wait between lookups, by how far off departure is. */
export function lookupGapMs(untilDepartureMs: number): number {
  if (untilDepartureMs > 6 * HOUR) return 18 * HOUR; // ~24 h out, then ~6 h out
  if (untilDepartureMs > 3 * HOUR) return HOUR;
  return 20 * 60 * 1000;
}

export async function runTravelWatchPass(): Promise<{ looked: number; alerts: number; skipped?: string }> {
  if (!deps) return { looked: 0, alerts: 0, skipped: "no-runner" };
  const d = deps;
  if (!getRuntimeConfig().travelWatchEnabled) return { looked: 0, alerts: 0, skipped: "disabled" };
  if (isLocalOnlyMode()) return { looked: 0, alerts: 0, skipped: "local-only" };
  const now = (d.now ?? (() => new Date()))();
  const { events } = await (d.window ?? eventsBetween)(now, new Date(now.getTime() + 24 * HOUR));
  const state = loadTravelState(d.statePath);
  const day = now.toDateString();
  if (state.usage.day !== day) state.usage = { day, lookups: 0 };
  let looked = 0;
  let alerts = 0;
  for (const e of events) {
    const flight = flightNumberOf(e.title);
    const departs = Date.parse(e.start);
    if (!flight || !Number.isFinite(departs) || departs <= now.getTime()) continue;
    const key = `${flight}@${departs}`;
    const seen = state.flights[key];
    if (seen && (seen.last?.status === "departed" || seen.last?.status === "landed" || seen.last?.status === "cancelled")) continue;
    if (seen && now.getTime() - seen.checkedAt < lookupGapMs(departs - now.getTime())) continue;
    if (state.usage.lookups >= DAILY_LOOKUP_CAP) break;
    state.usage.lookups++;
    looked++;
    try {
      const status = await lookUp(flight, e.start, e.title, e.location, d, now);
      const change = status ? changeOf(seen?.last, status, e.start) : null;
      state.flights[key] = { checkedAt: now.getTime(), ...(status ? { last: status } : seen?.last ? { last: seen.last } : {}) };
      if (status && change && inboxTravelChange({
        key: `travel:${key}:${status.status}:${status.departure ?? ""}:${status.gate ?? ""}`,
        title: `Flight ${flight} ${change}`,
        body: `${e.title}, scheduled ${new Date(e.start).toLocaleString()}.${status.terminal ? ` Terminal ${status.terminal}.` : ""}${status.source ? ` (From ${status.source}; check the airline before you go.)` : ""}`,
      })) alerts++;
    } catch (err) {
      state.flights[key] = { checkedAt: now.getTime(), ...(seen?.last ? { last: seen.last } : {}) };
      logger.warn(`[travel-watch] ${flight} lookup failed: ${(err as Error).message}`);
    }
  }
  pruneOld(state, now.getTime());
  saveTravelState(state, d.statePath);
  return { looked, alerts };
}

async function lookUp(flight: string, scheduled: string, title: string, where: string | undefined, d: TravelWatchDeps, now: Date) {
  const outcome = await (d.runFork ?? runReviewFork)({
    forkSessionId: `${TRAVEL_WATCH_SESSION_PREFIX}${now.getTime()}-${flight}`,
    message: buildTravelLookupMessage(flight, scheduled, title, where),
    systemPrompt: TRAVEL_WATCH_SYSTEM_PROMPT,
    section: { id: "travel-watch", label: "Travel Watch" },
    tools: d.webTools(),
    opType: OP_TYPE.travelWatch,
    maxIterations: 6,
    timeoutMs: 3 * 60 * 1000,
  }, d);
  const failure = reviewFailure(outcome);
  if (failure) throw new Error(`the lookup ${failure}`);
  return parseFlightStatus(forkReply(outcome));
}

function pruneOld(state: TravelState, now: number): void {
  for (const [key, v] of Object.entries(state.flights)) if (now - v.checkedAt > 3 * 24 * HOUR) delete state.flights[key];
}
