import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Handler } from "./handler.js";
import { hasInjects, _resetInjectQueues } from "../agent-loop/inject-queue.js";

// Seam: the agency message bus must deliver inter-agent messages onto the SAME
// session a spawned agent's canonical run drains. The bus bridge pushes to
// `agent-${agent.id}` (handler.ts); the run drains `req.sessionId ?? agent-${id}`
// (handler-events.ts). If those strings drift, the bridge is a silent no-op —
// opConsumesInjects is unit-tested in inject-queue.test.ts, but only this
// cross-module path proves the message actually lands where the drain looks.
describe("Handler message-bus → inject-queue bridge", () => {
  beforeEach(() => { Handler.resetInstance(); _resetInjectQueues(); });
  afterEach(() => { Handler.resetInstance(); _resetInjectQueues(); });

  it("lands an inter-agent message on the spawned agent's run session", async () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "peer", role: "coder", task: "do x" });
    expect(hasInjects(`agent-${agentId}`)).toBe(false);

    h.messageAgent(agentId, "use the staging endpoint, not prod");
    // The bridge pushes via a dynamic import().then(), so let the microtask run.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(hasInjects(`agent-${agentId}`)).toBe(true);
  });
});
