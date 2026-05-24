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

// Per-op dedup ledger for `error` events. Bug 2026-05-24: a single
// loop-detection abort surfaced as two identical "middleware-abort" bubbles
// in the IDE chat. Keying by (code, message) lets distinct errors (e.g.
// `stalled` then a later `worker_exception`) still surface while collapsing
// repeat emits of the same condition.
const EMITTED_ERRORS = new Map<string, Set<string>>();

export function emitErrorOnce(
  opId: string,
  body: { code: string; message: string; retryable?: boolean },
): CanonicalEvent | null {
  const key = `${body.code}|${body.message}`;
  let bucket = EMITTED_ERRORS.get(opId);
  if (!bucket) {
    bucket = new Set();
    EMITTED_ERRORS.set(opId, bucket);
  }
  if (bucket.has(key)) return null;
  bucket.add(key);
  return emit(opId, "error", body as unknown as Record<string, unknown>);
}

export function clearEmittedErrorsForOp(opId: string): void {
  EMITTED_ERRORS.delete(opId);
}

export function _resetEmittedErrors(): void {
  EMITTED_ERRORS.clear();
}
