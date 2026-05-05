/**
 * Canonical-loop control signals — bus side (Issue 05).
 *
 * Public-control APIs (opPause, opResume, future opCancel/opRedirect) write
 * a durable marker on the op (pause_requested_at, etc.) AND publish a
 * fast-path "signal" message on the bus. Workers can subscribe for low-
 * latency intake; the durable file remains the source of truth.
 *
 * Hard rule: only the public control API publishes signals. Workers / loop
 * internals NEVER publish here — they read the durable column instead.
 */
import { getBus, type BusListener } from "./bus.js";

export type CanonicalSignalKind = "pause" | "resume" | "cancel";

export interface PauseSignal {
  kind: "pause";
  opId: string;
  actor: string;
  ts: string;
}

export interface ResumeSignal {
  kind: "resume";
  opId: string;
  actor: string;
  ts: string;
}

export interface CancelSignal {
  kind: "cancel";
  opId: string;
  actor: string;
  ts: string;
}

export type CanonicalSignal = PauseSignal | ResumeSignal | CancelSignal;

/** Bus channel name for an op's control-signal stream. */
export function signalChannel(opId: string): string { return `op_signals:${opId}`; }

export function publishSignal(s: CanonicalSignal): void {
  getBus().publish(signalChannel(s.opId), s);
}

export type SignalListener = (s: CanonicalSignal) => void;

export function subscribeOpSignals(opId: string, listener: SignalListener): () => void {
  const wrapped: BusListener = (msg) => listener(msg as CanonicalSignal);
  return getBus().subscribe(signalChannel(opId), wrapped);
}
