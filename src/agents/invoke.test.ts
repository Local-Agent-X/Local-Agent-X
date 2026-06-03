import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Handler.getInstance() so awaitAgentRunning's status probe is ──
// driven by per-test state. We don't mock EventBus — it's a pure in-memory
// singleton, and the runId we use is unique per test so emits stay scoped.

let agentStatusImpl: (id: string) => { status: string } = () => {
  throw new Error("default not-found");
};

vi.mock("../agency/handler.js", () => ({
  Handler: {
    getInstance: () => ({
      getAgentStatus: (id: string) => agentStatusImpl(id),
    }),
  },
}));

import { awaitAgentRunning } from "./invoke.js";
import { EventBus } from "../event-bus.js";

// Counter to mint a unique runId per test — keeps stray listeners from
// previous tests inert even if cleanup ever slipped.
let runCounter = 0;
function nextRunId(): string {
  return `run-test-${++runCounter}`;
}

beforeEach(() => {
  // Default: not found. Tests override as needed.
  agentStatusImpl = () => { throw new Error("not found"); };
});

afterEach(() => {
  // Scrub the only event channel awaitAgentRunning subscribes on.
  EventBus.removeAllListeners("handler:agent-result");
  vi.restoreAllMocks();
});

describe("awaitAgentRunning", () => {
  it("fast-paths to running:true when the agent is already terminal-succeeded", async () => {
    const runId = nextRunId();
    agentStatusImpl = () => ({ status: "succeeded" });

    const result = await awaitAgentRunning(runId, 200);

    expect(result).toEqual({ running: true });
    // No listener leak from the fast path.
    expect(EventBus.listenerCount("handler:agent-result")).toBe(0);
  });

  it("resolves running:false when EventBus emits success:false within the window", async () => {
    const runId = nextRunId();
    // Status probe shows the run is working — not yet terminal.
    agentStatusImpl = () => ({ status: "working" });

    const promise = awaitAgentRunning(runId, 200);

    // Let the promise body wire up its EventBus listener.
    await new Promise((r) => setTimeout(r, 5));
    await EventBus.emit("handler:agent-result", {
      agentId: runId,
      success: false,
      error: "agent run failed during init",
    });

    const result = await promise;
    expect(result).toEqual({ running: false, reason: "agent run failed during init" });
    expect(EventBus.listenerCount("handler:agent-result")).toBe(0);
  });

  it("resolves running:false 'not found' when getAgentStatus throws", async () => {
    const runId = nextRunId();
    agentStatusImpl = () => { throw new Error(`Agent ${runId} not found`); };

    const result = await awaitAgentRunning(runId, 200);

    expect(result.running).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not found/);
    expect(EventBus.listenerCount("handler:agent-result")).toBe(0);
  });

  it("defaults to running:true on timeout (assume still running)", async () => {
    const runId = nextRunId();
    agentStatusImpl = () => ({ status: "working" });

    const result = await awaitAgentRunning(runId, 60);

    expect(result).toEqual({ running: true });
    expect(EventBus.listenerCount("handler:agent-result")).toBe(0);
  });

  it("ignores agent-result events scoped to a different runId", async () => {
    const runId = nextRunId();
    const otherRunId = nextRunId();
    agentStatusImpl = () => ({ status: "working" });

    const promise = awaitAgentRunning(runId, 80);
    await new Promise((r) => setTimeout(r, 5));

    // Fire failure for the WRONG agentId — must not resolve our promise.
    await EventBus.emit("handler:agent-result", {
      agentId: otherRunId,
      success: false,
      error: "different agent crashed",
    });

    const result = await promise;
    // We expect the timeout fallback (running:true), not the cross-agent failure.
    expect(result).toEqual({ running: true });
  });

  it("resolves running:true when EventBus emits success:true within the window", async () => {
    const runId = nextRunId();
    agentStatusImpl = () => ({ status: "working" });

    const promise = awaitAgentRunning(runId, 200);
    await new Promise((r) => setTimeout(r, 5));
    await EventBus.emit("handler:agent-result", {
      agentId: runId,
      success: true,
    });

    const result = await promise;
    expect(result).toEqual({ running: true });
  });
});
