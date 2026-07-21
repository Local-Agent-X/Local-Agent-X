import type { ServerEvent } from "../types.js";
import { readOp } from "../ops/op-store.js";
import { sendProcessRelayDelivery } from "../chat-ws/process-relay-delivery.js";
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

const GLOBAL_EVENT_TYPES = new Set([
  "bg_op_queued", "bg_op_started", "bg_op_progress", "bg_op_completed", "bg_op_nudge",
]);

setProcessRelayParentHandler(reconcilePendingProcessRelay);

export function reconcilePendingProcessRelay(opId: string): number {
  return reconcileProcessRelay(opId, (state, record, target) => {
    if (target === "canonical-core") return projectProcessRelayTarget(state, record, target);
    const delivery = buildBrowserDelivery(state, record);
    if (target === "session-observer") {
      for (const event of delivery.events) notifySessionEventObservers(delivery.sessionId, event);
      return true;
    }
    sendProcessRelayDelivery(delivery);
    return false;
  });
}

export function reconcileAllPendingProcessRelays(sessionId?: string): number {
  let applied = 0;
  for (const opId of listProcessRelayOperationIds()) {
    if (sessionId && readOp(opId)?.canonical?.sessionId !== sessionId) continue;
    try { applied += reconcilePendingProcessRelay(opId); } catch { /* next janitor pass retries */ }
  }
  return applied;
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

export function buildBrowserDelivery(
  state: Readonly<ProcessRelayGenerationState>,
  record: Readonly<ProcessRelayRecord>,
): ProcessRelayBrowserDelivery {
  const generation = state.sealedGeneration.generation;
  let events: ServerEvent[];
  if (record.kind === "canonical-event") {
    events = collectCanonicalBrowserEvents(canonicalRelayEvent(record), generation.sessionId)?.events ?? [];
  } else if (record.kind === "session-event") {
    events = [record.payload as ServerEvent];
  } else throw new Error("stream relay records have no browser projection");
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
    eventIds: events.map((_event, index) => `${record.deliveryId}:${index}`),
  };
}
