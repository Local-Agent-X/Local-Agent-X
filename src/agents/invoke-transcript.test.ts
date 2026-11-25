// A run can go on from a finished run's conversation: the same worker, its
// context intact (the build lead's "continue", auto-build/loop/handle-push-back.ts).
// The conversation goes to the caller that asked for it, once, and never onto
// the result every subscriber (the run store, the UI) sees.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../agency/handler.js", () => ({
  Handler: {
    getInstance: () => ({
      attachExternalRun: () => ({ agentId: `run-${Math.random().toString(36).slice(2, 8)}`, abortController: new AbortController() }),
      finalizeExternalRun: () => {},
    }),
  },
}));

const { invokeDefinition, takeRunTranscript } = await import("./invoke.js");
const { registerAgentRunDriver, _resetAgentRunDriverForTest } = await import("./runtime.js");
const { EventBus } = await import("../event-bus.js");
import type { AgentRunDriverRequest } from "./runtime.js";

const def = { id: "adhoc-worker", name: "Worker", role: "implementer", systemPrompt: "work", allowedTools: [], description: "a worker" };
const conversation = [{ role: "user" as const, content: "build chunk 3" }, { role: "assistant" as const, content: "STATUS: done" }];

afterEach(() => { _resetAgentRunDriverForTest(); EventBus.removeAllListeners("handler:agent-result"); });

function finished(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => EventBus.on("handler:agent-result", (d) => resolve(d as unknown as Record<string, unknown>)));
}

describe("a run's conversation", () => {
  it("is kept for the caller that asked, handed over once, and not put on the result subscribers see", async () => {
    const seen: AgentRunDriverRequest[] = [];
    registerAgentRunDriver(async (req) => { seen.push(req); return { result: "STATUS: done", success: true, ...(req.keepTranscript ? { transcript: conversation } : {}) }; });
    const done = finished();
    const ref = invokeDefinition(def, "build chunk 3", { keepTranscript: true });
    const event = await done;
    expect(event).not.toHaveProperty("transcript");
    expect(takeRunTranscript(ref.runId)).toEqual(conversation);
    expect(takeRunTranscript(ref.runId)).toBeUndefined();
    expect(seen[0].keepTranscript).toBe(true);
  });

  it("is what the next run goes on from", async () => {
    const seen: AgentRunDriverRequest[] = [];
    registerAgentRunDriver(async (req) => { seen.push(req); return { result: "ok", success: true }; });
    const done = finished();
    invokeDefinition(def, "the review sent your chunk back", { priorMessages: conversation });
    await done;
    expect(seen[0].priorMessages).toEqual(conversation);
  });
});
