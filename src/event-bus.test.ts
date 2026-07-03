import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "./event-bus.js";

// CT-6 regression: emit() must isolate listeners — one throwing or
// rejecting handler must never abort fanout to the others, and must
// never propagate into the emitter (which wedged awaitAgentRunning
// when a bad agent-result listener broke result delivery).
describe("EventBus listener isolation (CT-6)", () => {
  beforeEach(() => {
    EventBus.reset();
    // Failures are logged (via logger → console.error), not rethrown.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    EventBus.reset();
  });

  it("a synchronously-throwing listener does not abort fanout or propagate", async () => {
    const received: unknown[] = [];
    EventBus.on("agent:result", () => {
      throw new Error("bad listener");
    });
    EventBus.on("agent:result", (data) => {
      received.push(data);
    });

    await expect(EventBus.emit("agent:result", { runId: 1 })).resolves.toBeUndefined();
    expect(received).toEqual([{ runId: 1 }]);
  });

  it("an async-rejecting listener does not reject emit; other async listeners still complete", async () => {
    const received: unknown[] = [];
    EventBus.on("agent:result", async () => {
      throw new Error("async bad listener");
    });
    EventBus.on("agent:result", async (data) => {
      await Promise.resolve();
      received.push(data);
    });

    await expect(EventBus.emit("agent:result", { runId: 2 })).resolves.toBeUndefined();
    // emit awaits ALL listeners (allSettled), so the good one has landed.
    expect(received).toEqual([{ runId: 2 }]);
  });

  it("a throwing direct listener does not starve wildcard listeners", async () => {
    const received: unknown[] = [];
    EventBus.on("tool:start", () => {
      throw new Error("boom");
    });
    EventBus.on("tool:*", (data) => {
      received.push(data);
    });

    await expect(EventBus.emit("tool:start", "payload")).resolves.toBeUndefined();
    expect(received).toEqual(["payload"]);
  });
});
