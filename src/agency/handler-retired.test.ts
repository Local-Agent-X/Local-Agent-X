// Regression: OP-11 — finalizeExternalRun used to hard-delete the FieldAgent
// record 5 minutes after terminal, while the agent_output/agent_status tools
// direct the model to fetch the result by run id at any later point. A parent
// returning after the GC got "Agent not found" and the sub-agent's output was
// unreachable. Terminal runs must now be retired to a bounded store that the
// by-run-id readers fall back to.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Handler } from "./handler.js";
import type { FieldAgentStatus } from "./handler-types.js";

// Keep the test hermetic: the bound test finalizes >100 runs and each
// attachExternalRun would otherwise append a trace file under ~/.lax.
vi.mock("../agents/run-trace.js", () => ({
  appendTraceEvent: vi.fn(),
}));

const FIVE_MIN = 5 * 60 * 1000;

describe("Handler retired-run retention (OP-11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Handler.resetInstance();
  });
  afterEach(() => {
    Handler.resetInstance();
    vi.useRealTimers();
  });

  it("keeps agent_output answerable by run id after the 5-minute live-map GC", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.finalizeExternalRun(agentId, { result: "the answer is 42", success: true });
    vi.advanceTimersByTime(FIVE_MIN + 1);
    // Pre-fix: the record was deleted here → "Agent not found".
    expect(h.getAgentOutput(agentId).join("\n")).toContain("the answer is 42");
  });

  it("keeps agent_status answerable by run id after the GC", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.finalizeExternalRun(agentId, { result: "done", success: true });
    vi.advanceTimersByTime(FIVE_MIN + 1);
    const status = h.getAgentStatus(agentId) as FieldAgentStatus;
    expect(status.status).toBe("succeeded");
    expect(status.progress).toBe(100);
  });

  it("retains failed runs too", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.finalizeExternalRun(agentId, { result: "boom", success: false });
    vi.advanceTimersByTime(FIVE_MIN + 1);
    expect(h.getAgentOutput(agentId).join("\n")).toContain("boom");
    expect((h.getAgentStatus(agentId) as FieldAgentStatus).status).toBe("failed");
  });

  it("drops retired runs from the active list (no-id status stays live-only)", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "t", role: "coder", task: "do x" });
    h.finalizeExternalRun(agentId, { result: "done", success: true });
    vi.advanceTimersByTime(FIVE_MIN + 1);
    const list = h.getAgentStatus() as FieldAgentStatus[];
    expect(list.find((s) => s.id === agentId)).toBeUndefined();
  });

  it("bounds the retired store, evicting oldest first", () => {
    const h = Handler.getInstance();
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const { agentId } = h.attachExternalRun({ name: `t${i}`, role: "coder", task: "do x" });
      h.finalizeExternalRun(agentId, { result: `r${i}`, success: true });
      ids.push(agentId);
    }
    vi.advanceTimersByTime(FIVE_MIN + 1);
    // Cap is 100: the single oldest run fell off, everything newer survives.
    expect(() => h.getAgentOutput(ids[0])).toThrow(/not found/);
    expect(h.getAgentOutput(ids[1]).join("\n")).toContain("r1");
    expect(h.getAgentOutput(ids[100]).join("\n")).toContain("r100");
  });
});
