/**
 * In-process pub/sub bus for canonical-loop (Issue 03; PRD §12 — bus is a
 * fast-delivery hint, DB is source of truth).
 *
 * Two channel families:
 *   `op_events:{op_id}`  — canonical events also persisted to op_events.
 *   `op_stream:{op_id}`  — ephemeral stream chunks, never persisted.
 *
 * The bus is a singleton EventEmitter. Tests can swap it via setBus() to
 * intercept publishes without subscribing per channel.
 */
import { EventEmitter } from "node:events";

export type BusListener = (msg: unknown) => void;

export interface CanonicalBus {
  publish(channel: string, msg: unknown): void;
  subscribe(channel: string, listener: BusListener): () => void;
  reset(): void;
}

class InProcessBus implements CanonicalBus {
  private emitter = new EventEmitter();
  publish(channel: string, msg: unknown): void {
    // EventEmitter swallows listener errors via 'error' event; we want a
    // bad subscriber to NOT break delivery to other subscribers, so we
    // iterate listeners ourselves.
    const listeners = this.emitter.listeners(channel);
    for (const l of listeners) {
      try { (l as BusListener)(msg); } catch { /* one bad sub != broken bus */ }
    }
  }
  subscribe(channel: string, listener: BusListener): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
  reset(): void {
    this.emitter.removeAllListeners();
  }
}

let active: CanonicalBus = new InProcessBus();

export function getBus(): CanonicalBus { return active; }
export function setBus(b: CanonicalBus): void { active = b; }
export function resetBus(): void { active.reset(); }

export function streamChannel(opId: string): string { return `op_stream:${opId}`; }
export function eventsChannel(opId: string): string { return `op_events:${opId}`; }
