import type { ServerEvent } from "../types.js";
import { readOp } from "../ops/op-store.js";
import {
  GLOBAL_EVENT_TYPES,
  relayEventReachesATab,
  sendProcessRelayDelivery,
} from "../chat-ws/process-relay-delivery.js";
import {
  acknowledgeProcessRelayBrowserDelivery,
  readProcessRelayGenerations,
  type ProcessRelayGenerationState,
} from "./process-relay-journal.js";
import {
  canonicalRelayEvent,
  projectProcessRelayTarget,
  reconcileProcessRelay,
} from "./process-relay-reconcile.js";
import { collectCanonicalBrowserEvents } from "./session-bridge-observer.js";
import type {
  ProcessRelayBrowserAck,
  ProcessRelayBrowserDelivery,
  ProcessRelayRecord,
} from "./process-relay-contract.js";
import { setProcessRelayParentHandler } from "./process-relay-parent-hook.js";
import { listProcessRelayOperationIds } from "./process-relay-discovery.js";
import { notifySessionEventObservers } from "../chat-ws/session-event-observers.js";
import { yieldEventLoop } from "../util/time.js";

setProcessRelayParentHandler(reconcilePendingProcessRelay);

export function reconcilePendingProcessRelay(opId: string): number {
  return reconcileProcessRelay(opId, (state, record, target) => {
    if (target === "canonical-core") return projectProcessRelayTarget(state, record, target);
    if (target === "session-observer") {
      const sessionId = state.sealedGeneration.generation.sessionId;
      for (const event of relayedEvents(state, record)) notifySessionEventObservers(sessionId, event);
      return true;
    }
    const delivery = buildBrowserDelivery(state, record);
    // A record with nothing for any tab is rendered already. Sent, it could
    // only be acknowledged by a tab subscribed to its session, and a headless
    // session has none: every mail watch and failure review kept its journal
    // until the op itself was pruned a week later, and each pass over pending
    // relays visited them all (253 journals on one machine, 2026-11-27).
    if (delivery.events.length === 0) return true;
    sendProcessRelayDelivery(delivery);
    return false;
  });
}

function reconcileQuietly(opId: string): number {
  try { return reconcilePendingProcessRelay(opId); } catch { return 0; /* next janitor pass retries */ }
}

export function reconcileAllPendingProcessRelays(sessionId?: string): number {
  let applied = 0;
  for (const opId of listProcessRelayOperationIds()) {
    if (sessionId && readOp(opId)?.canonical?.sessionId !== sessionId) continue;
    applied += reconcileQuietly(opId);
  }
  return applied;
}

let backgroundPass: Promise<void> | undefined;
let wantEverySession = false;
const wantSessions = new Set<string>();

/**
 * The same pass for a caller that must not hold the server's thread: one op
 * at a time, with everything else given a turn between ops. Every new chat
 * connection and every subscription asks for it, so a delivery still pending
 * reaches the page that just arrived. Done all at once, the pass took a second
 * of each connect on a store with a few hundred relay journals (profile,
 * 2026-11-24).
 *
 * One pass runs at a time. A request made while one is running is folded into
 * one more pass after it: the ops already passed were judged before the asker
 * arrived. With no `sessionId` every op is reconciled; with one, that
 * session's ops.
 */
export function reconcilePendingProcessRelaysInBackground(sessionId?: string): Promise<void> {
  if (sessionId) wantSessions.add(sessionId); else wantEverySession = true;
  return (backgroundPass ??= (async () => {
    while (wantEverySession || wantSessions.size > 0) {
      const every = wantEverySession;
      const sessions = new Set(wantSessions);
      wantEverySession = false;
      wantSessions.clear();
      for (const opId of listProcessRelayOperationIds()) {
        if (every || sessions.has(readOp(opId)?.canonical?.sessionId ?? "")) reconcileQuietly(opId);
        await yieldEventLoop();
      }
    }
  })().finally(() => { backgroundPass = undefined; }));
}

export function acknowledgeBrowserProcessRelay(
  ack: ProcessRelayBrowserAck,
  subscribedToSession: boolean,
): boolean {
  let state: ProcessRelayGenerationState | undefined;
  let record: ProcessRelayRecord | undefined;
  try {
    state = readProcessRelayGenerations(ack.opId)
      .find(candidate => candidate.sealedGeneration.generation.generationId === ack.generationId);
    record = state?.records.find(candidate => candidate.cursor === ack.cursor);
  } catch {
    return false;
  }
  if (!state || !record) return false;
  const expected = buildBrowserDelivery(state, record);
  if (expected.sessionId !== ack.sessionId || expected.deliveryId !== ack.deliveryId
    || expected.generationId !== ack.generationId || expected.cursor !== ack.cursor
    || (expected.scope !== "global" && !subscribedToSession)) return false;
  if (!acknowledgeProcessRelayBrowserDelivery(ack)) return false;
  reconcilePendingProcessRelay(ack.opId);
  return true;
}

/** Every chat event one record carries, for whoever is listening to its session. */
function relayedEvents(
  state: Readonly<ProcessRelayGenerationState>,
  record: Readonly<ProcessRelayRecord>,
): ServerEvent[] {
  if (record.kind === "canonical-event") {
    const sessionId = state.sealedGeneration.generation.sessionId;
    return collectCanonicalBrowserEvents(canonicalRelayEvent(record), sessionId)?.events ?? [];
  }
  if (record.kind === "session-event") return [record.payload as ServerEvent];
  throw new Error("stream relay records have no browser projection");
}

/**
 * What the tabs are owed for one record: the events some tab can receive, each
 * under the id of its place in the record, so an event keeps its id whichever
 * others are left out. A headless session's batch is therefore its global
 * events alone, which any tab can acknowledge; before, the session's own events
 * stayed in it and the batch waited for a subscriber that cannot exist.
 */
export function buildBrowserDelivery(
  state: Readonly<ProcessRelayGenerationState>,
  record: Readonly<ProcessRelayRecord>,
): ProcessRelayBrowserDelivery {
  const generation = state.sealedGeneration.generation;
  const owed = relayedEvents(state, record)
    .map((event, index) => ({ event, id: `${record.deliveryId}:${index}` }))
    .filter(({ event }) => relayEventReachesATab(generation.sessionId, event.type));
  const events = owed.map(({ event }) => event);
  const globalCount = events.filter(event => GLOBAL_EVENT_TYPES.has(event.type)).length;
  const scope = globalCount === events.length && events.length > 0
    ? "global" as const
    : globalCount > 0 ? "mixed" as const : "session" as const;
  return {
    type: "process_relay_delivery",
    opId: generation.opId,
    sessionId: generation.sessionId,
    generationId: generation.generationId,
    cursor: record.cursor,
    deliveryId: record.deliveryId,
    scope,
    events,
    eventIds: owed.map(({ id }) => id),
  };
}
