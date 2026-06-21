import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Handler } from "./handler.js";
import { drainInjects, hasInjects, _resetInjectQueues } from "../agent-loop/inject-queue.js";

// Seam: agent_redirect must reach the RUNNING canonical sub-agent, not the dead
// FieldAgent.messageQueue (which a canonically-driven run never reads). The
// worker drains the inject queue keyed on `req.sessionId ?? agent-${id}`
// (handler-events.ts) via drainInjectsIntoTurn; redirectAgent must push to that
// same bucket — runSessionId when borrowed, else agent-${id}. Sibling of
// handler-bus-bridge.test.ts, which proves the agent_message path; this proves
// the agent_redirect path that was silently dropping every redirect.
describe("Handler agent_redirect → inject-queue delivery", () => {
  beforeEach(() => { Handler.resetInstance(); _resetInjectQueues(); });
  afterEach(() => { Handler.resetInstance(); _resetInjectQueues(); });

  it("lands the new instruction on the spawned agent's run session", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "worker", role: "worker", task: "original task" });
    // agent_spawn leaves runSessionId undefined → canonical session is agent-<id>.
    const sessionId = `agent-${agentId}`;
    expect(hasInjects(sessionId)).toBe(false);

    h.redirectAgent(agentId, "pivot: focus on the staging deploy instead");

    expect(hasInjects(sessionId)).toBe(true);
    expect(drainInjects(sessionId).map((i) => i.text)).toContain(
      "pivot: focus on the staging deploy instead",
    );
  });

  it("delivers to the borrowed runSessionId when the run carries one", () => {
    const h = Handler.getInstance();
    const borrowed = "agent-op-borrowed-123";
    const { agentId } = h.attachExternalRun({
      name: "phase", role: "operator", task: "phase task", runSessionId: borrowed,
    });
    h.redirectAgent(agentId, "use the new spec");

    // Lands on the borrowed bucket the run's tools actually use, not agent-<id>.
    expect(hasInjects(borrowed)).toBe(true);
    expect(hasInjects(`agent-${agentId}`)).toBe(false);
  });
});
