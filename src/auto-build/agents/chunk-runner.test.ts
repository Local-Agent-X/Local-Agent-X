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
vi.mock("../../agents/invoke.js", () => ({
  invokeDefinition: () => ({ runId: RUN_ID, definition: {} }),
}));

import { runChunkAgent, _clearChunkAgentDefCache } from "./chunk-runner.js";
import { Handler } from "../../agency/handler.js";
import { EventBus } from "../../event-bus.js";

let cancelSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _clearChunkAgentDefCache();
  cancelSpy = vi.spyOn(Handler.getInstance(), "cancelAgent").mockImplementation(() => {});
});

afterEach(() => {
  cancelSpy.mockRestore();
});

describe("runChunkAgent lifecycle cancellation (AB-1)", () => {
  it("timeout → cancels the underlying run (exit 124)", async () => {
    const res = await runChunkAgent({ role: "chunk-runner-leaf", task: "do the thing", timeoutMs: 5 });
    expect(res.exitCode).toBe(124);
    expect(cancelSpy).toHaveBeenCalledWith(RUN_ID);
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
    const p = runChunkAgent({ role: "chunk-runner-leaf", task: "do the thing", timeoutMs: 60_000 });
    await EventBus.emit("handler:agent-result", { agentId: RUN_ID, success: true, result: "STATUS: done" });
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
