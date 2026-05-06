/**
 * Canonical event emitter (PRD §12).
 *
 * Single seam through which the loop writes a canonical event:
 *   1. Append-only persist via store.appendCanonicalEvent (assigns per-op
 *      monotonic seq, writes to canonical-events.jsonl).
 *   2. Publish on the in-process bus channel `op_events:{op_id}`.
 *
 * Stream chunks (PRD §12 "stream chunks are bus-only and ephemeral") are
 * published through publishStreamChunk and never persisted.
 *
 * Hard rule: callers other than canonical-loop modules must NOT use this —
 * adapters/workers go through their own contract surface, public control
 * APIs use signal columns (Issue 05+).
 */
import { appendCanonicalEvent } from "./store.js";
import { getBus, eventsChannel, streamChannel } from "./bus.js";
import { recordCanonicalEvent, recordStreamChunk } from "./soak-metrics.js";
import { recordCanonicalEvent as bridgeRecord } from "./session-bridge-observer.js";
import type { CanonicalEvent, CanonicalEventType } from "./types.js";

export function emit(
  opId: string,
  type: CanonicalEventType,
  body: Record<string, unknown> | null = null,
): CanonicalEvent {
  const event = appendCanonicalEvent(opId, type, body);
  getBus().publish(eventsChannel(opId), event);
  recordCanonicalEvent(event);
  bridgeRecord(event);
  return event;
}

export function publishStreamChunk(opId: string, chunk: unknown): void {
  getBus().publish(streamChannel(opId), chunk);
  recordStreamChunk(opId);
}
