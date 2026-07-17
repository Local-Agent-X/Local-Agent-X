// Event-pump op-stream mapping: marker chunks published by adapters ride the
// same bus as text deltas. The `stopped` marker (degenerate-stream guard)
// must surface as a `stopped` ServerEvent — and never leak into the stream
// lane — while bare/unknown chunks stay dropped (the long-standing consumer
// invariant: forward only non-empty `delta` or `replace:true`).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Listener = (chunk: unknown) => void;
const listeners = new Map<string, Listener>();

vi.mock("../control-api.js", () => ({
  subscribeOpStream: vi.fn((opId: string, l: Listener) => {
    listeners.set(opId, l);
    return () => listeners.delete(opId);
  }),
  subscribeOpEvents: vi.fn(() => () => {}),
}));

import { createEventPump } from "./event-pump.js";

beforeEach(() => listeners.clear());

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
