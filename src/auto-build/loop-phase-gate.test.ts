// Regression (F5): the phase-gate recovery loop received the full
// LoopOptions — parentSessionId + parentOpId included — but dropped BOTH
// before calling runAutoFixWorker, so the scenario-fix worker spawned with
// no lineage at all: unattributed in the sidebar, a parentless root in the
// AGENTS panel, and one parentSessionId-only wiring away from injecting
// its STATUS block into the user's chat. The caller must thread both keys,
// exactly as run.ts does for preflight/chunk workers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runPhaseGateScoring, runAutoFixWorker, consultAdvisor } = vi.hoisted(() => ({
  runPhaseGateScoring: vi.fn(),
  runAutoFixWorker: vi.fn(),
  consultAdvisor: vi.fn(),
}));
vi.mock("./scenario-scorer/phase-gate-runner.js", () => ({ runPhaseGateScoring }));
vi.mock("./scenario-scorer/auto-fix.js", () => ({ runAutoFixWorker }));
vi.mock("./advisor/index.js", () => ({ consultAdvisor }));

import { attemptPhaseGateScoring } from "./loop-phase-gate.js";
import type { ParsedChunk, ParsedPlan } from "./plan-parser.js";
import type { LoopOptions } from "./loop.js";
import type { ScoreReport } from "./scenario-scorer/types.js";

const chunk: ParsedChunk = {
  number: 1, title: "t", phase: "P", klass: "mixed", slice: "s",
  dependsOn: [], scenarios: "—", doneWhen: "d", rawSection: "",
};

const failedReport = {
  scenarioTitle: "login works", score: 3, passed: false,
  reasoning: "broken", failedCriteria: [], steps: [],
} as unknown as ScoreReport;

function loopOptions(): LoopOptions {
  return {
    projectDir: "/tmp/lax-phase-gate-project",
    planPath: "/tmp/plan.md",
    plan: {} as ParsedPlan,
    startingChunk: 1,
    parentSessionId: "chat-session-1",
    parentOpId: "orchestrator-op-77",
  };
}

describe("attemptPhaseGateScoring → runAutoFixWorker lineage", () => {
  beforeEach(() => {
    runPhaseGateScoring.mockReset();
    runAutoFixWorker.mockReset();
    consultAdvisor.mockReset();
  });

  it("threads parentSessionId + parentOpId from LoopOptions into the fix worker", async () => {
    runPhaseGateScoring
      .mockResolvedValueOnce({ kind: "failures", reports: [failedReport], failedReports: [failedReport] })
      .mockResolvedValueOnce({ kind: "proceed", reports: [] });
    consultAdvisor.mockResolvedValue(null); // advisor unavailable → try-fix-worker fallback
    runAutoFixWorker.mockResolvedValue({ workerCompleted: true, workerReport: "STATUS: done", durationMs: 1, fixSha: null });

    const outcome = await attemptPhaseGateScoring(loopOptions(), chunk, () => {}, 1);

    expect(outcome).toEqual({ kind: "recovered" });
    expect(runAutoFixWorker).toHaveBeenCalledTimes(1);
    expect(runAutoFixWorker.mock.calls[0][0]).toMatchObject({
      projectDir: "/tmp/lax-phase-gate-project",
      parentSessionId: "chat-session-1",
      parentOpId: "orchestrator-op-77",
    });
  });

  it("a non-orchestrator caller (no lineage on LoopOptions) passes undefined through — worker renders as a root", async () => {
    runPhaseGateScoring
      .mockResolvedValueOnce({ kind: "failures", reports: [failedReport], failedReports: [failedReport] })
      .mockResolvedValueOnce({ kind: "proceed", reports: [] });
    consultAdvisor.mockResolvedValue(null);
    runAutoFixWorker.mockResolvedValue({ workerCompleted: true, workerReport: "STATUS: done", durationMs: 1, fixSha: null });

    const opts = loopOptions();
    delete opts.parentSessionId;
    delete opts.parentOpId;
    await attemptPhaseGateScoring(opts, chunk, () => {}, 1);

    expect(runAutoFixWorker.mock.calls[0][0].parentSessionId).toBeUndefined();
    expect(runAutoFixWorker.mock.calls[0][0].parentOpId).toBeUndefined();
  });
});
