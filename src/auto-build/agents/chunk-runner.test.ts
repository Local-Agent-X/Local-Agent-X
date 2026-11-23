// Regression for AB-1: a timed-out / aborted chunk agent must CANCEL its
// underlying canonical run, not just resolve the local promise. The old code
// let the orphan keep editing the SAME projectDir (racing a retry's writes)
// and burn tokens indefinitely. runChunkAgent must call
// Handler.cancelAgent(runId) on the timeout/abort exits — and must NOT call it
// on a natural agent-result completion (the run is already terminal).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the definition build cheap + hermetic (no bundled SKILL.md read).
vi.mock("../skill-bodies.js", () => ({ loadSkillBody: () => "SKILL BODY" }));

// Stub the canonical spawn — we only care about lifecycle, not a real run.
const RUN_ID = "run-ab1";
const invokeCalls: Array<{ task: string; opts: Record<string, unknown> }> = [];
vi.mock("../../agents/invoke.js", () => ({
  invokeDefinition: (_def: unknown, task: string, opts: Record<string, unknown>) => {
    invokeCalls.push({ task, opts });
    return { runId: RUN_ID, definition: {} };
  },
}));

import { runChunkAgent, _clearChunkAgentDefCache } from "./chunk-runner.js";
import { Handler } from "../../agency/handler.js";
import { EventBus } from "../../event-bus.js";

let cancelSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _clearChunkAgentDefCache();
  invokeCalls.length = 0;
  cancelSpy = vi.spyOn(Handler.getInstance(), "cancelAgent").mockImplementation(() => {});
});

afterEach(() => {
  cancelSpy.mockRestore();
});

describe("runChunkAgent lifecycle cancellation (AB-1)", () => {
  it("silence → cancels the underlying run (exit 124) and says it went silent", async () => {
    const res = await runChunkAgent({ role: "chunk-runner-leaf", task: "do the thing", silenceLimitMs: 5 });
    expect(res.exitCode).toBe(124);
    expect(res.error).toContain("went silent");
    expect(cancelSpy).toHaveBeenCalledWith(RUN_ID);
  });

  // label-check chunk 3 (2026-11-23): a worker editing steadily was killed by a
  // fixed 30-minute clock. Output and tool calls keep a run alive.
  it("a run that keeps working outlives its silence limit; only going quiet ends it", async () => {
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "do the thing", silenceLimitMs: 60 });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await EventBus.emit("handler:agent-output", { agentId: RUN_ID, output: "[tool] edit..." });
    }
    await EventBus.emit("handler:agent-output", { agentId: "someone-else", output: "[tool] bash..." });
    const res = await p;
    expect(res.exitCode).toBe(124);
    expect(res.durationMs).toBeGreaterThanOrEqual(180);
  });

  it("a deadline (the preflight probe) ends the run however busy it is", async () => {
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "probe", silenceLimitMs: 60_000, deadlineMs: 50 });
    const keepBusy = setInterval(() => { void EventBus.emit("handler:agent-output", { agentId: RUN_ID, output: "[tool] bash..." }); }, 10);
    const res = await p;
    clearInterval(keepBusy);
    expect(res.exitCode).toBe(124);
    expect(res.error).toContain("deadline");
  });

  it("caller abort → cancels the underlying run (exit 130)", async () => {
    const controller = new AbortController();
    // The abort listener is registered synchronously inside runChunkAgent's
    // promise executor, so aborting after the call is observed.
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "do the thing", signal: controller.signal });
    controller.abort();
    const res = await p;
    expect(res.exitCode).toBe(130);
    expect(cancelSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it("natural completion → does NOT cancel (run already terminal)", async () => {
    const p = runChunkAgent({ role: "chunk-runner-leaf", task: "do the thing", silenceLimitMs: 60_000 });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "STATUS: done" });
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe("runChunkAgent spawn lineage", () => {
  it("maps parentOpId → invokeDefinition parentAgentId so the worker is an orchestrator child", async () => {
    const p = runChunkAgent({ role: "scenario-fix", task: "fix it", parentSessionId: "chat-session-1", parentOpId: "orchestrator-op-77", silenceLimitMs: 60_000 });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "STATUS: done" });
    await p;
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].opts.parentSessionId).toBe("chat-session-1");
    expect(invokeCalls[0].opts.parentAgentId).toBe("orchestrator-op-77");
  });
});

describe("runChunkAgent task provenance", () => {
  it("marks the spawn harness-authored so the instruction ledger skips its preamble", async () => {
    // The working-directory preamble ("Never touch paths outside it") is
    // harness prose. Without this flag it extracts as a user workspace-write
    // ban and every worker write is hard-denied (2026-07-22 Merchhelm halt).
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "do the thing", projectDir: "/tmp/proj", silenceLimitMs: 60_000 });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "STATUS: done" });
    await p;
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].opts.harnessAuthoredTask).toBe(true);
    expect(invokeCalls[0].task).toContain("Never touch paths outside it");
  });
});
