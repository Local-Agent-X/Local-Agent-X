/**
 * Programmable mock for the AnthropicTransport interface.
 *
 * Test fixture only. Lets Issue 09 conformance tests script per-turn
 * provider streams without touching subprocess / HTTP code paths. Mirrors
 * the FakeAdapter pattern from Issue 02: each call to `stream()` drains
 * one scripted plan, and `respectsAbort` controls whether the transport
 * cuts the stream short on `signal.aborted`.
 */
import type {
  AnthropicTransport,
  AnthropicTransportRequest,
  TransportEvent,
} from "../../src/canonical-loop/adapters/anthropic.js";

export interface MockTurnPlan {
  /** Events to yield in order. Optional `delayMs` between each. */
  events: { delayMs?: number; event: TransportEvent }[];
}

export interface MockTransportOpts {
  plans: MockTurnPlan[];
  /** When true, an aborted `signal` ends the iteration immediately. Default true. */
  respectsAbort?: boolean;
  /** Inspection hook: receives every request the transport saw. */
  onRequest?: (req: AnthropicTransportRequest) => void;
}

export class MockAnthropicTransport implements AnthropicTransport {
  private callIdx = 0;
  public requests: AnthropicTransportRequest[] = [];

  constructor(private readonly opts: MockTransportOpts) {}

  enqueue(plan: MockTurnPlan): void {
    this.opts.plans.push(plan);
  }

  async *stream(req: AnthropicTransportRequest): AsyncIterable<TransportEvent> {
    this.requests.push(req);
    this.opts.onRequest?.(req);

    const respectsAbort = this.opts.respectsAbort !== false;
    const plan = this.opts.plans[this.callIdx] ?? { events: [{ event: { type: "done" } }] };
    this.callIdx++;

    for (const item of plan.events) {
      if (respectsAbort && req.signal.aborted) return;
      if (item.delayMs && item.delayMs > 0) {
        await abortableSleep(item.delayMs, req.signal, respectsAbort);
        if (respectsAbort && req.signal.aborted) return;
      }
      yield item.event;
    }
  }
}

async function abortableSleep(ms: number, signal: AbortSignal, respectAbort: boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (respectAbort && signal.aborted) return;
    await new Promise<void>(r => setTimeout(r, Math.min(5, ms)));
  }
}

// ── Convenience plan constructors ────────────────────────────────────────

export function planText(...deltas: string[]): MockTurnPlan {
  return {
    events: [
      ...deltas.map(d => ({ delayMs: 2, event: { type: "text" as const, delta: d } })),
      { event: { type: "done" as const, stopReason: "end_turn" } },
    ],
  };
}

export function planToolCall(call: { id: string; name: string; arguments: string }): MockTurnPlan {
  return {
    events: [
      { event: { type: "tool_call", ...call } },
      { event: { type: "done", stopReason: "tool_use" } },
    ],
  };
}

export function planError(code: string, message: string, retryable = false): MockTurnPlan {
  return {
    events: [
      { event: { type: "error", code, message, retryable } },
      { event: { type: "done", stopReason: "error" } },
    ],
  };
}

/** Long stream that won't naturally finish — use with abort tests. */
export function planLongStream(chunks = 200, intervalMs = 25): MockTurnPlan {
  const events: { delayMs?: number; event: TransportEvent }[] = [];
  for (let i = 0; i < chunks; i++) {
    events.push({ delayMs: intervalMs, event: { type: "text", delta: `t${i}` } });
  }
  events.push({ event: { type: "done", stopReason: "end_turn" } });
  return { events };
}
