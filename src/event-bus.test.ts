import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "./event-bus.js";

const line = (output: string) => ({ agentId: "a1", output });

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
    EventBus.on("handler:agent-output", () => {
      throw new Error("bad listener");
    });
    EventBus.on("handler:agent-output", (data) => {
      received.push(data);
    });

    await expect(EventBus.emit("handler:agent-output", line("one"))).resolves.toBeUndefined();
    expect(received).toEqual([line("one")]);
  });

  it("an async-rejecting listener does not reject emit; other async listeners still complete", async () => {
    const received: unknown[] = [];
    EventBus.on("handler:agent-output", async () => {
      throw new Error("async bad listener");
    });
    EventBus.on("handler:agent-output", async (data) => {
      await Promise.resolve();
      received.push(data);
    });

    await expect(EventBus.emit("handler:agent-output", line("two"))).resolves.toBeUndefined();
    // emit awaits ALL listeners (allSettled), so the good one has landed.
    expect(received).toEqual([line("two")]);
  });

  it("a throwing direct listener does not starve wildcard listeners", async () => {
    const received: unknown[] = [];
    EventBus.on("handler:agent-output", () => {
      throw new Error("boom");
    });
    EventBus.on("handler:*", (data) => {
      received.push(data);
    });

    await expect(EventBus.emit("handler:agent-output", line("three"))).resolves.toBeUndefined();
    expect(received).toEqual([line("three")]);
  });
});
