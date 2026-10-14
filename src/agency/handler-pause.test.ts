import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Handler } from "./handler.js";
import { newOpId, readOp, writeOp } from "../ops/op-store.js";
import { trackOpForSession, releaseOpFromSession } from "../ops/session-bridge.js";
import type { Op } from "../ops/types.js";

// Seam: agent_pause / agent_resume must reach the RUNNING canonical op, not a
// FieldAgent.pauseSignal flag nothing read. The run's op is tracked under its
// session (runSessionId ?? agent-<id>, the inject/redirect bucket); pause is
// the loop's own opPause (lands at the turn boundary), resume its opResume.
describe("Handler agent_pause / agent_resume → canonical op", () => {
  const created: string[] = [];

  const liveOp = (sessionId: string): Op => {
    const op: Op = {
      id: newOpId("op_agent_spawn"),
      sessionId,
      type: "agent_spawn",
      task: "do x",
      contextPack: {} as Op["contextPack"],
      lane: "agent",
      retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
      ownerId: "local-user",
      visibility: "private",
      status: "running",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      canonical: { flagValue: true, state: "running", sessionId, pauseRequestedAt: null },
    };
    writeOp(op);
    trackOpForSession(op.id, sessionId, op.task);
    created.push(op.id);
    return op;
  };

  beforeEach(() => { Handler.resetInstance(); });
  afterEach(() => {
    Handler.resetInstance();
    for (const id of created) {
      releaseOpFromSession(id);
      const dir = join(homedir(), ".lax", "operations", id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    created.length = 0;
  });

  it("pause records the loop's pause signal on the run's op; resume withdraws it before it lands", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "worker", role: "worker", task: "do x" });
    const op = liveOp(`agent-${agentId}`);

    h.pauseAgent(agentId);
    expect(readOp(op.id)?.canonical?.pauseRequestedAt).toBeTruthy();
    expect(h.getAgentStatus(agentId)).toMatchObject({ status: "waiting" });

    h.resumeAgent(agentId);
    expect(readOp(op.id)?.canonical?.pauseRequestedAt).toBeNull();
    expect(readOp(op.id)?.canonical?.state).toBe("running");
    expect(h.getAgentStatus(agentId)).toMatchObject({ status: "working" });
  });

  it("resume re-queues an op the loop already paused", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "worker", role: "worker", task: "do x" });
    const op = liveOp(`agent-${agentId}`);
    const paused = readOp(op.id)!;
    paused.canonical!.state = "paused";
    writeOp(paused);

    h.resumeAgent(agentId);
    expect(readOp(op.id)?.canonical?.state).toBe("queued");
  });

  it("refuses to pause a run with no live canonical op instead of pretending", () => {
    const h = Handler.getInstance();
    const { agentId } = h.attachExternalRun({ name: "worker", role: "worker", task: "do x" });
    expect(() => h.pauseAgent(agentId)).toThrow(/no running operation/);
  });
});
