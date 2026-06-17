import { describe, it, expect } from "vitest";
import { opConsumesInjects } from "./inject-queue.js";

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
