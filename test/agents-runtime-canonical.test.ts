/**
 * Tests for the canonical-loop dispatch path invokeDefinition now rides on
 * (F1 closure, phase 2B).
 *
 * Three pin points:
 *
 *   1. Driver dispatch — invokeDefinition routes the run through the
 *      registered AgentRunDriver (not Handler.runAgentAsync). The driver
 *      receives the resolved tools, system prompt, agent id, and an
 *      AbortSignal.
 *
 *   2. Event-bridge — the driver's terminal outcome flows out as
 *      handler:agent-result (+ done/error) on the EventBus. chunk-runner
 *      and the AgentRunStore-persistence subscriber both depend on these
 *      signals being emitted with the same shape as before.
 *
 *   3. Cancel parity — Handler.cancelAgent on an invokeDefinition-driven
 *      run aborts the AbortSignal handed to the driver. After 2B, the
 *      driver passes this signal through to runAgentViaCanonical so
 *      cancellation routes through canonical's opCancel.
 *
 * The crash-recovery assertion (kill mid-tool, replay from
 * op_events.jsonl) is covered structurally here: invokeDefinition rides
 * on `runAgentViaCanonical`, and canonical-loop-04-reconnect-replay
 * already pins the persistence + replay contract for any run that goes
 * through it. Together: every agent invocation after this commit is
 * recoverable from its op_events.jsonl on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeDefinition } from "../src/agents/invoke.js";
import {
  registerAgentRunDriver,
  _resetAgentRunDriverForTest,
  type AgentRunDriverRequest,
  type AgentRunDriverResult,
} from "../src/agents/runtime.js";
import { Handler } from "../src/agency/handler.js";
import { EventBus } from "../src/event-bus.js";
import type { AgentDefinition } from "../src/agents/types.js";

const TEST_DEF: AgentDefinition = {
  id: "builtin-test-runner",
  name: "Test Runner",
  role: "tester",
  systemPrompt: "Run the test.",
  allowedTools: ["read", "write"],
  description: "Fixture for runtime-dispatch tests.",
};

function captureEvent<T = unknown>(name: string): { drain: () => T[] } {
  const seen: T[] = [];
  const handler = (data: unknown) => { seen.push(data as T); };
  EventBus.on(name, handler);
  return {
    drain: () => {
      EventBus.off(name, handler);
      return seen;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetAgentRunDriverForTest();
  Handler.resetInstance();
});

afterEach(() => {
  _resetAgentRunDriverForTest();
  Handler.resetInstance();
});

describe("invokeDefinition — routes through registered canonical-loop driver", () => {
  it("invokes the registered driver with the resolved request shape", async () => {
    let received: AgentRunDriverRequest | null = null;
    let signalReceived: AbortSignal | null = null;
    registerAgentRunDriver(async (req, signal) => {
      received = req;
      signalReceived = signal;
      return { result: "driver-done", success: true, tokens: 7 };
    });

    const resultCapture = captureEvent<{ agentId: string; result: string; success: boolean; tokens?: number }>("handler:agent-result");
    const doneCapture = captureEvent<{ agentId: string; result: string }>("handler:agent-done");

    const ref = invokeDefinition(TEST_DEF, "do a thing", {
      parentSessionId: "sess-xyz",
      nameOverride: "Test override",
    });

    expect(ref.runId).toMatch(/^field-agent-/);
    expect(ref.fieldAgentId).toBe(ref.runId);
    expect(ref.definition.id).toBe(TEST_DEF.id);

    await waitFor(() => resultCapture.drain().length > 0 || doneCapture.drain().length > 0, 500).catch(() => {});
    // Re-attach captures after waitFor's drain — both subscriptions were
    // consumed; re-subscribe to read the steady state.
    const finalResults: Array<{ agentId: string; result: string; success: boolean; tokens?: number }> = [];
    const finalDones: Array<{ agentId: string; result: string }> = [];
    EventBus.on("handler:agent-result", (d) => { finalResults.push(d as typeof finalResults[number]); });
    EventBus.on("handler:agent-done", (d) => { finalDones.push(d as typeof finalDones[number]); });

    // Drive a fresh invocation since the captures were already drained.
    const ref2 = invokeDefinition(TEST_DEF, "do another thing", {});
    await waitFor(() => finalResults.some(r => r.agentId === ref2.fieldAgentId), 1_000);

    expect(received).not.toBeNull();
    expect(received!.agentId).toBeDefined();
    expect(received!.name).toBe("Test Runner");
    expect(received!.role).toBe("tester");
    expect(received!.task).toBeDefined();
    expect(received!.systemPrompt).toBe("Run the test.");
    expect(received!.tools).toEqual(["read", "write"]);
    expect(signalReceived).not.toBeNull();
    expect(signalReceived!.aborted).toBe(false);

    const r2 = finalResults.find(r => r.agentId === ref2.fieldAgentId);
    expect(r2).toBeDefined();
    expect(r2!.success).toBe(true);
    expect(r2!.result).toBe("driver-done");
    expect(r2!.tokens).toBe(7);
  });

  it("emits handler:agent-spawn synchronously with the resolved agentId", async () => {
    registerAgentRunDriver(async () => ({ result: "", success: true }));
    const spawns: Array<{ agentId: string; name: string; role: string; templateId: string | null }> = [];
    EventBus.on("handler:agent-spawn", (d) => { spawns.push(d as typeof spawns[number]); });

    const ref = invokeDefinition(TEST_DEF, "task", { parentSessionId: "sess-1" });

    expect(spawns).toHaveLength(1);
    expect(spawns[0].agentId).toBe(ref.fieldAgentId);
    expect(spawns[0].name).toBe("Test Runner");
    expect(spawns[0].role).toBe("tester");
    expect(spawns[0].templateId).toBeNull(); // builtin- id, not tpl-
  });

  it("registers the FieldAgent in Handler's map so legacy status tools find the run", async () => {
    let resolveDriver: (r: AgentRunDriverResult) => void;
    registerAgentRunDriver((_req, _signal) => new Promise(resolve => { resolveDriver = resolve; }));

    const ref = invokeDefinition(TEST_DEF, "in-flight task", {});
    const status = Handler.getInstance().getAgentStatus(ref.fieldAgentId);
    expect(Array.isArray(status)).toBe(false);
    if (Array.isArray(status)) return;
    expect(status.id).toBe(ref.fieldAgentId);
    expect(status.name).toBe("Test Runner");
    expect(status.role).toBe("tester");
    expect(status.status).toBe("working");

    // Resolve so the test doesn't dangle.
    resolveDriver!({ result: "ok", success: true });
    await waitFor(() => Handler.getInstance().getAgentStatus(ref.fieldAgentId) !== null && (Handler.getInstance().getAgentStatus(ref.fieldAgentId) as { status: string }).status !== "working", 1_000).catch(() => {});
  });

  it("translates a driver rejection into handler:agent-result with success:false", async () => {
    registerAgentRunDriver(async () => { throw new Error("driver blew up"); });
    const results: Array<{ agentId: string; result: string; success: boolean }> = [];
    EventBus.on("handler:agent-result", (d) => { results.push(d as typeof results[number]); });

    const ref = invokeDefinition(TEST_DEF, "task", {});
    await waitFor(() => results.some(r => r.agentId === ref.fieldAgentId), 1_000);

    const r = results.find(r => r.agentId === ref.fieldAgentId);
    expect(r).toBeDefined();
    expect(r!.success).toBe(false);
    expect(r!.result).toBe("driver blew up");
  });

  it("translates a success:false outcome into handler:agent-error + handler:agent-result", async () => {
    registerAgentRunDriver(async () => ({ result: "merge conflict", success: false }));
    const errors: Array<{ agentId: string; error: string }> = [];
    const results: Array<{ agentId: string; result: string; success: boolean }> = [];
    EventBus.on("handler:agent-error", (d) => { errors.push(d as typeof errors[number]); });
    EventBus.on("handler:agent-result", (d) => { results.push(d as typeof results[number]); });

    const ref = invokeDefinition(TEST_DEF, "task", {});
    await waitFor(() => results.some(r => r.agentId === ref.fieldAgentId), 1_000);

    expect(errors.find(e => e.agentId === ref.fieldAgentId)?.error).toBe("merge conflict");
    expect(results.find(r => r.agentId === ref.fieldAgentId)?.success).toBe(false);
  });

  it("Handler.cancelAgent fires the AbortSignal the driver received", async () => {
    let driverSignal: AbortSignal | null = null;
    let resolveDriver: (r: AgentRunDriverResult) => void;
    registerAgentRunDriver((_req, signal) => {
      driverSignal = signal;
      return new Promise(resolve => {
        resolveDriver = resolve;
        signal.addEventListener("abort", () => { resolve({ result: "[cancelled]", success: false }); });
      });
    });
    const results: Array<{ agentId: string; result: string; success: boolean }> = [];
    EventBus.on("handler:agent-result", (d) => { results.push(d as typeof results[number]); });

    const ref = invokeDefinition(TEST_DEF, "task", {});
    await waitFor(() => driverSignal !== null, 500);

    expect(driverSignal!.aborted).toBe(false);
    Handler.getInstance().cancelAgent(ref.fieldAgentId);
    expect(driverSignal!.aborted).toBe(true);

    await waitFor(() => results.some(r => r.agentId === ref.fieldAgentId), 1_000);
    const r = results.find(r => r.agentId === ref.fieldAgentId);
    expect(r!.success).toBe(false);
    // Resolve to ensure cleanup
    resolveDriver!({ result: "[cancelled]", success: false });
  });
});

describe("invokeDefinition — chunk-runner subscription compatibility", () => {
  it("emits handler:agent-done with the same shape chunk-runner.ts subscribes to", async () => {
    registerAgentRunDriver(async () => ({ result: "STATUS: done\nDONE_WHEN: met", success: true, tokens: 42 }));
    const dones: Array<{ agentId: string; result: string }> = [];
    EventBus.on("handler:agent-done", (d) => { dones.push(d as typeof dones[number]); });

    const ref = invokeDefinition(TEST_DEF, "ship chunk", {});
    await waitFor(() => dones.some(d => d.agentId === ref.fieldAgentId), 1_000);

    const d = dones.find(d => d.agentId === ref.fieldAgentId);
    expect(d).toBeDefined();
    expect(d!.result).toContain("STATUS: done");
  });
});
