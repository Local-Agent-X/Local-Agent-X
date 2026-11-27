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
  invokeDefinition: (def: unknown, task: string, opts: Record<string, unknown>) => {
    invokeCalls.push({ task, opts, def } as never);
    return { runId: RUN_ID, definition: {} };
  },
  takeRunTranscript: (runId: string) => (runId === RUN_ID ? [{ role: "assistant", content: "what the worker did" }] : undefined),
}));

import { runChunkAgent, _clearChunkAgentDefCache } from "./chunk-runner.js";
import { breakerFindingsTool, chunkReportTool, skepticVerdictTool } from "./report-tools.js";
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
  it("goes on from the last worker's conversation, and hands its own back when asked", async () => {
    const prior = [{ role: "user" as const, content: "build chunk 3" }];
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "the review sent it back", priorMessages: prior, keepTranscript: true });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "STATUS: done" });
    const res = await p;
    expect(invokeCalls[0].opts).toMatchObject({ priorMessages: prior, keepTranscript: true });
    expect(res.transcript).toEqual([{ role: "assistant", content: "what the worker did" }]);
  });

  // Declared files were never claimed, so a sibling writing into one was told
  // nothing until the merge conflicted (label-check-grok, 2026-11-26).
  it("claims the files the plan gives the chunk, and claims nothing when the plan gives none", async () => {
    const p = runChunkAgent({ role: "chunk-runner-leaf", task: "build chunk 7", touches: ["src/dsld/client.ts", "src/dsld/normalize.ts"] });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "done" });
    await p;
    expect(invokeCalls[0].opts).toMatchObject({ touches: ["src/dsld/client.ts", "src/dsld/normalize.ts"] });

    const q = runChunkAgent({ role: "chunk-runner-leaf", task: "build chunk 8", touches: [] });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "done" });
    await q;
    expect(invokeCalls[1].opts).not.toHaveProperty("touches");
  });

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

// A build agent ends its run by calling its report tool; the engine takes what
// was delivered when the run ends, however it ends (agent-report.ts).
describe("runChunkAgent returns what the run reported", () => {
  const session = `agent-${RUN_ID}`;
  const done = { status: "done", done_when: "met", note: "built the list and ran its tests", _sessionId: session };

  it("a worker's chunk_report comes back beside its output", async () => {
    const p = runChunkAgent({ role: "chunk-runner-trunk", task: "do the thing", silenceLimitMs: 60_000 });
    expect((await chunkReportTool.execute(done)).isError).toBeFalsy();
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "narration" });
    const res = await p;
    expect(res.chunkReport).toMatchObject({ status: "done", doneWhen: "met", note: "built the list and ran its tests" });
    expect(res.skepticVerdict).toBeUndefined();
  });

  it("is kept when the run's text guards call it failed, and when the run is cut off after reporting", async () => {
    const failed = runChunkAgent({ role: "chunk-skeptic", task: "review", projectDir: "C:/proj", silenceLimitMs: 60_000 });
    await skepticVerdictTool.execute({ verdict: "holds", finding: "probed the edges", _sessionId: session });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: false, result: "[Agent did not finish]" });
    expect((await failed).skepticVerdict).toMatchObject({ verdict: "holds" });

    const cut = runChunkAgent({ role: "finish-breaker", task: "attack", projectDir: "C:/proj", silenceLimitMs: 40 });
    await breakerFindingsTool.execute({ findings: [{ severity: "high", text: "the list drops its last item", reach: "reachable", reach_why: "anyone with two items" }], _sessionId: session });
    const res = await cut;
    expect(res.exitCode).toBe(124);
    expect(res.breakerFindings?.findings).toEqual([{ severity: "high", text: "the list drops its last item", reach: "reachable", reachWhy: "anyone with two items" }]);
  });

  it("a run that never reported returns none, and a call after it ended is refused", async () => {
    const p = runChunkAgent({ role: "chunk-runner-leaf", task: "do the thing", silenceLimitMs: 60_000 });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "narration" });
    expect((await p).chunkReport).toBeUndefined();
    const late = await chunkReportTool.execute(done);
    expect(late.isError).toBe(true);
    expect(late.content).toContain("No build is waiting");
  });

  it("each role is offered its own report tool, and only that one", () => {
    const tools = (role: Parameters<typeof runChunkAgent>[0]["role"]) => { invokeCalls.length = 0; void runChunkAgent({ role, task: "t", projectDir: "C:/proj", silenceLimitMs: 1 }); return (invokeCalls[0] as unknown as { def: { allowedTools: string[] } }).def.allowedTools.filter((t) => ["chunk_report", "skeptic_verdict", "breaker_findings"].includes(t)); };
    expect(tools("chunk-runner-trunk")).toEqual(["chunk_report"]);
    expect(tools("chunk-runner-leaf")).toEqual(["chunk_report"]);
    expect(tools("scenario-fix")).toEqual(["chunk_report"]);
    expect(tools("chunk-skeptic")).toEqual(["skeptic_verdict"]);
    expect(tools("finish-breaker")).toEqual(["breaker_findings"]);
  });
});
