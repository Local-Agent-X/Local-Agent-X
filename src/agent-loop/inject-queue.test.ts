import { describe, it, expect, afterEach } from "vitest";
import {
  opConsumesInjects,
  pushInject,
  drainInjects,
  hasQueuedInjectText,
  _resetInjectQueues,
} from "./inject-queue.js";

describe("opConsumesInjects", () => {
  it("returns true for the interactive chat thread", () => {
    expect(opConsumesInjects("chat_turn")).toBe(true);
  });

  it("returns true for spawned agents so the message bus reaches them", () => {
    // Regression: the agency message bus bridged inter-agent messages onto the
    // spawned agent's private session, but the drain/continue/extend gates were
    // hardcoded to chat_turn only, so those messages never landed mid-run.
    expect(opConsumesInjects("agent_spawn")).toBe(true);
  });

  it("returns false for freeform / delegated ops that must not steal chat injects", () => {
    expect(opConsumesInjects("freeform")).toBe(false);
    expect(opConsumesInjects("build_app")).toBe(false);
    expect(opConsumesInjects("")).toBe(false);
  });
});

describe("hasQueuedInjectText — identical-text dedup", () => {
  const sessionId = "sess-dedup";
  afterEach(() => _resetInjectQueues());

  it("is false when nothing is queued for the session", () => {
    expect(hasQueuedInjectText(sessionId, "make it blue")).toBe(false);
  });

  it("is true once an identical, un-drained copy is waiting", () => {
    pushInject(sessionId, "make it blue");
    expect(hasQueuedInjectText(sessionId, "make it blue")).toBe(true);
    // A different message does not collide.
    expect(hasQueuedInjectText(sessionId, "make it red")).toBe(false);
  });

  it("goes false again once the queue is drained — re-asking later is allowed", () => {
    pushInject(sessionId, "run the tests");
    expect(hasQueuedInjectText(sessionId, "run the tests")).toBe(true);
    drainInjects(sessionId);
    // The running turn consumed it; the same text is now a legitimate new ask.
    expect(hasQueuedInjectText(sessionId, "run the tests")).toBe(false);
  });

  it("does not leak across sessions", () => {
    pushInject(sessionId, "deploy");
    expect(hasQueuedInjectText("other-sess", "deploy")).toBe(false);
  });
});
