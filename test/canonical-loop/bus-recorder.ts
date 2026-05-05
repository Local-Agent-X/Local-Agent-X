/**
 * In-memory bus + BusRecorder for canonical-loop tests (Issue 02).
 *
 * Production bus lands in Issue 03. For test purposes we provide a minimal
 * pub/sub on a channel-keyed string map; subscribers are invoked
 * synchronously in registration order.
 *
 * BusRecorder subscribes to one or more channels and stores every
 * delivered message. Tests use it to assert what FakeAdapter forwarded to
 * `op_stream:{op_id}` (canonical-loop will do this forwarding in Issue 03;
 * tests do it explicitly via `forwardStreamChunksToBus()`).
 */

import type { AdapterReport } from "../../src/canonical-loop/adapter-contract.js";

type Listener = (msg: unknown) => void;

export class TestBus {
  private listeners = new Map<string, Set<Listener>>();
  private published: Array<{ channel: string; msg: unknown; ts: number }> = [];

  publish(channel: string, msg: unknown): void {
    this.published.push({ channel, msg, ts: Date.now() });
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const l of set) {
      try { l(msg); } catch { /* don't let one bad sub break delivery */ }
    }
  }

  subscribe(channel: string, l: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(l);
    return () => set!.delete(l);
  }

  /** All messages published, in order of publish. */
  publishedAll(): Array<{ channel: string; msg: unknown }> {
    return this.published.map(({ channel, msg }) => ({ channel, msg }));
  }

  reset(): void {
    this.listeners.clear();
    this.published = [];
  }
}

export interface BusRecording {
  channel: string;
  msg: unknown;
  ts: number;
}

export class BusRecorder {
  private records: BusRecording[] = [];
  private unsubs: Array<() => void> = [];

  constructor(private readonly bus: TestBus) {}

  watch(channel: string): this {
    const off = this.bus.subscribe(channel, (msg) => {
      this.records.push({ channel, msg, ts: Date.now() });
    });
    this.unsubs.push(off);
    return this;
  }

  records_(): BusRecording[] {
    return [...this.records];
  }

  /** Filter to one channel. */
  on(channel: string): unknown[] {
    return this.records.filter(r => r.channel === channel).map(r => r.msg);
  }

  reset(): void {
    this.records = [];
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
}

/**
 * Wire an adapter's `report` callback so `stream_chunk` adapter_reports get
 * forwarded onto the test bus channel `op_stream:{op_id}` — mirroring what
 * canonical-loop will do in Issue 03. Returns a `report` function tests
 * pass into `adapter.runTurn(input, report)`.
 */
export function forwardStreamChunksToBus(
  bus: TestBus,
  opId: string,
  inner?: (r: AdapterReport) => void,
): (r: AdapterReport) => void {
  const channel = `op_stream:${opId}`;
  return (r: AdapterReport) => {
    if (r.kind === "stream_chunk") bus.publish(channel, r.body);
    if (inner) inner(r);
  };
}
