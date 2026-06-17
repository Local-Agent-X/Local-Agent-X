import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Handler } from "./handler.js";
import type { FieldAgentStatus } from "./handler-types.js";

describe("Handler progress (real tool-call counter)", () => {
  beforeEach(() => Handler.resetInstance());
  afterEach(() => Handler.resetInstance());

  function progressOf(agentId: string): number {
    const status = Handler.getInstance().getAgentStatus(agentId) as FieldAgentStatus;
    return status.progress;
  }

  it("shows a small floor before any tool runs, not a dead 0", () => {
    // Regression: the old heuristic was Math.min(95, output.length * 5), but
    // output[] stays empty for canonical-loop runs, pinning progress at 0 the
    // entire run.
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    expect(progressOf(agentId)).toBe(5);
  });

  it("climbs as tool calls are noted", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.noteAgentActivity(agentId);
    h.noteAgentActivity(agentId);
    expect(progressOf(agentId)).toBe(16); // 2 * 8
  });

  it("caps in-flight progress below 100 so a running agent never reads complete", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    for (let i = 0; i < 50; i++) h.noteAgentActivity(agentId);
    expect(progressOf(agentId)).toBe(90);
  });

  it("reports 100 only once terminal", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.noteAgentActivity(agentId);
    h.finalizeExternalRun(agentId, { result: "done", success: true });
    expect(progressOf(agentId)).toBe(100);
  });

  it("noteAgentActivity is a no-op for an unknown agent", () => {
    expect(() => Handler.getInstance().noteAgentActivity("nope")).not.toThrow();
  });
});
