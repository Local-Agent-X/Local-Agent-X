/**
 * Canonical-loop public control API surface (Issue 04 scope).
 *
 * Issue 04 lands the `op_events_since` reconnect API and the bus
 * subscription / reconnect helpers it pairs with. Pause / cancel / redirect /
 * resume APIs ship in issues 05–07.
 *
 * Reconnect protocol (PRD §12):
 *   1. Client tracks the seq of the last event it received.
 *   2. On reconnect, call `opEventsSince(op_id, last_seq)` and replay rows
 *      in seq order to rebuild local state.
 *   3. Re-attach to the bus event channel so subsequent events flow live.
 *      `reconnectOp(...)` does steps 1–3 atomically with bus dedup.
 *
 * Stream chunks (`op_stream:{op_id}`) are bus-only and never replayed —
 * callers that re-attach via `subscribeOpStream` get the live tail only.
 */
import type { CanonicalEvent, CanonicalLane } from "./types.js";
import { readCanonicalEvents } from "./store.js";
import { readOp, writeOp } from "../workers/op-store.js";
import { getBus, eventsChannel, streamChannel, type BusListener } from "./bus.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { enqueueOp, pumpScheduler } from "./scheduler.js";
import { publishSignal } from "./signals.js";

/** Sentinel for `seq` arg of `opEventsSince`: replay from the beginning. */
export const OP_EVENTS_FROM_BEGINNING = -1;

export interface OpEventsSinceOk {
  ok: true;
  events: CanonicalEvent[];
  /** Seq of the latest persisted event for this op (null if no events yet). */
  latestSeq: number | null;
}

export interface OpEventsSinceErr {
  ok: false;
  code: "unknown_op" | "invalid_seq" | "invalid_op_id";
  message: string;
}

export type OpEventsSinceResult = OpEventsSinceOk | OpEventsSinceErr;

/**
 * Read durable canonical events for an op with `seq > sinceSeq`.
 *
 * - `sinceSeq = OP_EVENTS_FROM_BEGINNING (-1)` returns the full history.
 * - `sinceSeq >= MAX(seq)` returns an empty list (NOT an error).
 * - Unknown `opId` returns `{ ok: false, code: "unknown_op" }` rather than
 *   throwing — callers can treat it as a soft failure.
 *
 * Synchronous filesystem read; safe to call repeatedly. Loop is the sole
 * writer of `op_events`, so reads here are append-only consistent.
 */
export function opEventsSince(opId: string, sinceSeq: number): OpEventsSinceResult {
  if (typeof opId !== "string" || opId.length === 0) {
    return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  }
  if (!Number.isInteger(sinceSeq) || sinceSeq < OP_EVENTS_FROM_BEGINNING) {
    return {
      ok: false,
      code: "invalid_seq",
      message: `seq must be an integer >= ${OP_EVENTS_FROM_BEGINNING}, got ${sinceSeq}`,
    };
  }
  if (!readOp(opId)) {
    return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };
  }
  const all = readCanonicalEvents(opId);
  const events = sinceSeq === OP_EVENTS_FROM_BEGINNING
    ? all
    : all.filter(e => e.seq > sinceSeq);
  const latestSeq = all.length > 0 ? all[all.length - 1].seq : null;
  return { ok: true, events, latestSeq };
}

// ── Live subscription helpers ─────────────────────────────────────────────

export type CanonicalEventListener = (event: CanonicalEvent) => void;
export type StreamChunkListener = (chunk: unknown) => void;

/** Subscribe to the bus channel for canonical events on a single op. */
export function subscribeOpEvents(opId: string, listener: CanonicalEventListener): () => void {
  const wrapped: BusListener = (msg) => listener(msg as CanonicalEvent);
  return getBus().subscribe(eventsChannel(opId), wrapped);
}

/**
 * Subscribe to ephemeral stream chunks for an op.
 *
 * Stream chunks are bus-only — they are NOT persisted to op_events and
 * therefore NOT replayable. Re-attaching after a disconnect gives the live
 * tail only.
 */
export function subscribeOpStream(opId: string, listener: StreamChunkListener): () => void {
  const wrapped: BusListener = (msg) => listener(msg);
  return getBus().subscribe(streamChannel(opId), wrapped);
}

// ── Reconnect (replay + subscribe with dedup) ─────────────────────────────

export interface ReconnectOk {
  ok: true;
  /** Highest seq replayed from disk during reconnect (null if none replayed). */
  latestReplayedSeq: number | null;
  /** Detach the bus subscription. Idempotent. */
  off: () => void;
}

export interface ReconnectErr {
  ok: false;
  code: OpEventsSinceErr["code"];
  message: string;
}

export type ReconnectResult = ReconnectOk | ReconnectErr;

/**
 * Replay durable events with `seq > sinceSeq` then attach to the bus event
 * channel for the op. Listener is invoked once per event in monotonic seq
 * order; events delivered during the replay window are de-duplicated by
 * seq, so callers never see a duplicate or a gap.
 *
 * Use `OP_EVENTS_FROM_BEGINNING` for `sinceSeq` to start from scratch.
 */
export function reconnectOp(
  opId: string,
  sinceSeq: number,
  listener: CanonicalEventListener,
): ReconnectResult {
  const seenSeqs = new Set<number>();
  let inReplay = true;
  const buffered: CanonicalEvent[] = [];

  const off = subscribeOpEvents(opId, (e) => {
    if (inReplay) { buffered.push(e); return; }
    if (seenSeqs.has(e.seq)) return;
    seenSeqs.add(e.seq);
    listener(e);
  });

  const replay = opEventsSince(opId, sinceSeq);
  if (!replay.ok) {
    off();
    return { ok: false, code: replay.code, message: replay.message };
  }

  let latestReplayedSeq: number | null = null;
  for (const e of replay.events) {
    seenSeqs.add(e.seq);
    listener(e);
    latestReplayedSeq = e.seq;
  }
  inReplay = false;

  for (const e of buffered) {
    if (seenSeqs.has(e.seq)) continue;
    seenSeqs.add(e.seq);
    listener(e);
  }

  return { ok: true, latestReplayedSeq, off };
}

// ── Issue 05: opPause / opResume ──────────────────────────────────────────

/**
 * Canonical control-API result envelope. `ok: true` means the request was
 * accepted; for pause that means the signal was recorded (the actual
 * running→paused state transition lands at the next turn boundary). For
 * resume it means the paused→queued transition + re-enqueue have happened
 * synchronously.
 */
export interface ControlOk { ok: true }
export interface ControlErr {
  ok: false;
  code: "unknown_op" | "invalid_op_id" | "terminal" | "not_paused";
  message: string;
}
export type ControlResult = ControlOk | ControlErr;

const TERMINAL_STATES = new Set<string>(["succeeded", "failed", "cancelled"]);

/**
 * Soft-pause an op (PRD §13).
 *
 * Writes `pause_requested_at` on the op (durable), emits the
 * `pause_requested` canonical event, and publishes a fast-path signal on
 * `op_signals:{opId}`. The worker applies the pause at the NEXT turn
 * boundary (after the current turn's commit) — there are no mid-turn
 * pauses in v1.
 *
 * Idempotent on already-paused ops AND on running ops that already have a
 * pending pause request — neither re-emits `pause_requested`.
 *
 * Cancel beats pause/redirect (PRD §13). `opPause` does not check for a
 * pending cancel here; the worker's turn-boundary handler enforces the
 * precedence.
 */
export function opPause(opId: string, actor: string): ControlResult {
  if (typeof opId !== "string" || opId.length === 0) {
    return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  }
  const op = readOp(opId);
  if (!op) return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };
  const state = op.canonical?.state;
  if (state && TERMINAL_STATES.has(state)) {
    return { ok: false, code: "terminal", message: `op ${opId} is already ${state}` };
  }
  // Idempotent: already paused, or pause already pending — no double event.
  if (state === "paused") return { ok: true };
  if (op.canonical?.pauseRequestedAt) return { ok: true };

  if (!op.canonical) op.canonical = {};
  const now = new Date().toISOString();
  op.canonical.pauseRequestedAt = now;
  writeOp(op);
  emit(opId, "pause_requested", { actor });
  publishSignal({ kind: "pause", opId, actor, ts: now });
  return { ok: true };
}

/**
 * Resume a paused op (PRD §13).
 *
 * Synchronous: emits `resume_requested`, transitions paused→queued (which
 * emits `state_changed`), then enqueues the op + pumps the scheduler so
 * a worker leases it again. The next turn's adapter call receives the
 * prior `provider_state` from the last `op_turns` row (already supported
 * by checkpoint.ts on resume — see PRD §11).
 */
export function opResume(opId: string, actor: string): ControlResult {
  if (typeof opId !== "string" || opId.length === 0) {
    return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  }
  const op = readOp(opId);
  if (!op) return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };
  if (op.canonical?.state !== "paused") {
    return {
      ok: false,
      code: "not_paused",
      message: `op ${opId} is in state '${op.canonical?.state ?? "<unset>"}', not 'paused'`,
    };
  }
  const now = new Date().toISOString();
  emit(opId, "resume_requested", { actor });
  publishSignal({ kind: "resume", opId, actor, ts: now });
  transitionOp(op, "queued", "resumed");
  enqueueOp(op.id, op.lane as CanonicalLane);
  pumpScheduler();
  return { ok: true };
}

// ── Issue 06: opCancel ────────────────────────────────────────────────────

/**
 * Hard-cancel an op (PRD §13).
 *
 * Writes `cancel_requested_at` durably (read-modify-write so other signal
 * columns owned by the control API are not clobbered), emits the
 * `cancel_requested` canonical event, and publishes a fast-path
 * `CancelSignal` on `op_signals:{opId}`. The worker's signal handler
 * reacts immediately — it transitions running → cancelling and calls
 * `adapter.abort()` mid-stream (PRD acceptance #2: abort within 1s).
 *
 * Idempotent on already-cancelling ops AND on ops that already have a
 * pending cancel request — neither re-emits `cancel_requested` nor
 * re-publishes the signal.
 *
 * Cancel beats pause beats redirect (PRD §13). The worker's per-iteration
 * boundary check enforces the precedence; this entrypoint just records
 * the intent.
 */
export function opCancel(opId: string, actor: string): ControlResult {
  if (typeof opId !== "string" || opId.length === 0) {
    return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  }
  const op = readOp(opId);
  if (!op) return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };
  const state = op.canonical?.state;
  if (state && TERMINAL_STATES.has(state)) {
    return { ok: false, code: "terminal", message: `op ${opId} is already ${state}` };
  }
  // Idempotent: cancel already in flight or already pending.
  if (state === "cancelling") return { ok: true };
  if (op.canonical?.cancelRequestedAt) return { ok: true };

  if (!op.canonical) op.canonical = {};
  const now = new Date().toISOString();
  op.canonical.cancelRequestedAt = now;
  // Direct writeOp on the disk-loaded op preserves all other fields the
  // worker / state-machine wrote (state, lease, currentTurnIdx, signal
  // columns owned by other control APIs).
  writeOp(op);
  emit(opId, "cancel_requested", { actor });
  publishSignal({ kind: "cancel", opId, actor, ts: now });
  return { ok: true };
}
