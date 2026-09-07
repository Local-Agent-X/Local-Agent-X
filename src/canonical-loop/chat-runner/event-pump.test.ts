// Event-pump op-stream mapping: marker chunks published by adapters ride the
// same bus as text deltas. The `stopped` marker (degenerate-stream guard)
// must surface as a `stopped` ServerEvent — and never leak into the stream
// lane — while bare/unknown chunks stay dropped (the long-standing consumer
// invariant: forward only non-empty `delta` or `replace:true`).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Listener = (chunk: unknown) => void;
const listeners = new Map<string, Listener>();
type EventListener = (event: { type: string; body?: Record<string, unknown> }) => void;
const eventListeners = new Map<string, EventListener>();

vi.mock("../control-api.js", () => ({
  subscribeOpStream: vi.fn((opId: string, l: Listener) => {
    listeners.set(opId, l);
    return () => listeners.delete(opId);
  }),
  subscribeOpEvents: vi.fn((opId: string, l: EventListener) => {
    eventListeners.set(opId, l);
    return () => eventListeners.delete(opId);
  }),
}));

import { createEventPump } from "./event-pump.js";

beforeEach(() => { listeners.clear(); eventListeners.clear(); });

const abortedEvent = { type: "error", body: { code: "aborted", message: "adapter aborted" } };
const ABORTED_SERVER_EVENT = { type: "error", message: "aborted: adapter aborted" };

/** Resolve to "hung" if `p` has not settled within `ms`. */
function orHung<T>(p: Promise<T>, ms = 50): Promise<T | "hung"> {
  return Promise.race([p, new Promise<"hung">(r => setTimeout(() => r("hung"), ms))]);
}

describe("event pump op-stream mapping", () => {
  it("maps a stopped marker chunk to a `stopped` ServerEvent", async () => {
    const pump = createEventPump("op-1");
    listeners.get("op-1")!({
      stopped: true,
      reason: "Local model output degenerated — stream stopped early",
      debug: "tail repetition: trailing 100-char block repeated 3x consecutively",
      firedBy: "stream-guard",
    });
    const { events } = await pump.pull();
    expect(events).toEqual([
      {
        type: "stopped",
        reason: "Local model output degenerated — stream stopped early",
        debug: "tail repetition: trailing 100-char block repeated 3x consecutively",
        firedBy: "stream-guard",
      },
    ]);
    pump.dispose();
  });

  it("still forwards deltas and drops bare chunks", async () => {
    const pump = createEventPump("op-2");
    const listener = listeners.get("op-2")!;
    listener({ text: "no delta, no replace — must be dropped" });
    listener({ delta: "hello" });
    const { events } = await pump.pull();
    expect(events).toEqual([{ type: "stream", delta: "hello" }]);
    pump.dispose();
  });
});

// The adapter's `aborted` error is held back one event so a following
// deadline_exceeded can replace it with the human notice. The hold must never
// outlive the pump: when `aborted` is the LAST event the op ever emits (the
// worker bails on lease loss / a commit fence and never transitions), nothing
// follows to flush it — pull() hung and dispose() dropped the only error the
// user would ever have seen.
describe("event pump — held `aborted` error", () => {
  it("is delivered on dispose when nothing follows it", async () => {
    const pump = createEventPump("op-3");
    eventListeners.get("op-3")!(abortedEvent);
    pump.dispose();
    const pulled = await orHung(pump.pull());
    expect(pulled).not.toBe("hung");
    expect((pulled as { events: unknown[] }).events).toEqual([ABORTED_SERVER_EVENT]);
  });

  it("resolves a pull() that was already waiting, instead of hanging it forever", async () => {
    const pump = createEventPump("op-4");
    eventListeners.get("op-4")!(abortedEvent);
    const pending = pump.pull(); // nothing queued yet — the hold is the only thing there
    expect(await orHung(pending, 20)).toBe("hung"); // held: a hold IS one event of latency
    pump.dispose();
    const pulled = await orHung(pending);
    expect(pulled).not.toBe("hung");
    expect((pulled as { events: unknown[]; terminal: unknown })).toEqual({ events: [ABORTED_SERVER_EVENT], terminal: null });
  });

  it("is still replaced by the deadline notice when deadline_exceeded follows", async () => {
    const pump = createEventPump("op-5");
    const emit = eventListeners.get("op-5")!;
    emit(abortedEvent);
    emit({ type: "error", body: { code: "deadline_exceeded", message: "maxWallTimeMs=1000", elapsedMs: 60_000 } });
    const { events } = await pump.pull();
    expect(events.map(e => e.type)).toEqual(["stream", "stopped"]);
    expect(events).not.toContainEqual(ABORTED_SERVER_EVENT);
    pump.dispose();
    // Nothing left in the hold to leak on dispose either — and a disposed
    // pump's pull() returns rather than waiting on a bus it left.
    expect(await orHung(pump.pull())).toEqual({ events: [], terminal: null });
  });

  // The deadline is not the only coded cause of an adapter abort: the worker
  // also aborts the adapter on the per-op token ceiling and on an uncaught
  // exception, and emits a coded error for each. Those must REPLACE the held
  // acknowledgement exactly as the deadline does — not be delivered behind it
  // as "aborted" and then the reason.
  it.each(["max_tokens_exceeded", "worker_exception"])("is replaced by a following %s, which is delivered alone", async (code) => {
    const pump = createEventPump(`op-cause-${code}`);
    const emit = eventListeners.get(`op-cause-${code}`)!;
    emit(abortedEvent);
    emit({ type: "error", body: { code, message: `${code} happened` } });
    const { events } = await pump.pull();
    expect(events).toEqual([{ type: "error", message: `${code}: ${code} happened` }]);
    pump.dispose();
    expect(await orHung(pump.pull())).toEqual({ events: [], terminal: null });
  });

  it("is still flushed AHEAD of an unrelated coded error, in order", async () => {
    const pump = createEventPump("op-unrelated");
    const emit = eventListeners.get("op-unrelated")!;
    emit(abortedEvent);
    emit({ type: "error", body: { code: "provider_500", message: "upstream" } });
    const { events } = await pump.pull();
    expect(events).toEqual([ABORTED_SERVER_EVENT, { type: "error", message: "provider_500: upstream" }]);
    pump.dispose();
  });

  it("is flushed unchanged and in order when any other event follows", async () => {
    const pump = createEventPump("op-6");
    const emit = eventListeners.get("op-6")!;
    emit(abortedEvent);
    emit({ type: "state_changed", body: { from: "running", to: "failed" } });
    const pulled = await pump.pull();
    expect(pulled).toEqual({ events: [ABORTED_SERVER_EVENT], terminal: "failed" });
    pump.dispose();
  });
});
