import { afterEach, describe, expect, it, vi } from "vitest";
import {
  broadcastToSession,
  setSessionBroadcaster,
  setSessionRelayWriter,
} from "../ops/session-bridge.js";

afterEach(() => {
  setSessionRelayWriter(null);
  setSessionBroadcaster(() => {});
});

describe("process relay session output", () => {
  it("routes exclusively through the durable writer when installed", () => {
    const broadcast = vi.fn();
    const relay = vi.fn();
    setSessionBroadcaster(broadcast);
    setSessionRelayWriter(relay);
    const event = { type: "error" as const, message: "test" };
    broadcastToSession("session-1", event);
    expect(relay).toHaveBeenCalledWith("session-1", event);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("propagates durable writer failure so a child cannot lose output silently", () => {
    setSessionBroadcaster(vi.fn());
    setSessionRelayWriter(() => { throw new Error("journal unavailable"); });
    expect(() => broadcastToSession("session-1", { type: "error", message: "test" }))
      .toThrow("journal unavailable");
  });

  it("preserves normal in-process broadcaster behavior when no writer exists", () => {
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);
    setSessionRelayWriter(null);
    const event = { type: "error" as const, message: "test" };
    broadcastToSession("session-1", event);
    expect(broadcast).toHaveBeenCalledWith("session-1", event);
  });
});
