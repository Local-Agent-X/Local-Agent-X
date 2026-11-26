// Regression for AB-3: the scenario-fix worker was spawned without projectDir,
// so it ran from the LAX repo root and could not touch the project it was
// meant to repair — the re-score then failed identically. It must receive the
// project dir.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runChunkAgent } = vi.hoisted(() => ({ runChunkAgent: vi.fn() }));
vi.mock("../agents/chunk-runner.js", () => ({ runChunkAgent }));
vi.mock("../git-helpers.js", () => ({ gitAdd: vi.fn(async () => {}) }));
vi.mock("../loop-effects.js", () => ({ commitChunk: vi.fn(async () => ({ committed: true, sha: "abc1234" })) }));

import { runAutoFixWorker } from "./auto-fix.js";
import type { ParsedChunk } from "../plan-parser.js";

const chunk: ParsedChunk = {
  number: 1, title: "t", phase: "P", klass: "mixed", slice: "s",
  dependsOn: [], scenarios: "—", doneWhen: "d", rawSection: "",
};

describe("runAutoFixWorker (AB-3)", () => {
  beforeEach(() => runChunkAgent.mockReset());

  it("passes projectDir to the scenario-fix worker so it can edit the project", async () => {
    // Fail fast so the worker returns before git commit steps.
    runChunkAgent.mockResolvedValue({ exitCode: 1, stdout: "", durationMs: 1, error: "boom" });

    await runAutoFixWorker({
      projectDir: "/tmp/lax-scenario-project",
      chunk, failedReports: [], allReports: [],
    });

    expect(runChunkAgent).toHaveBeenCalledTimes(1);
    expect(runChunkAgent.mock.calls[0][0]).toMatchObject({
      role: "scenario-fix",
      projectDir: "/tmp/lax-scenario-project",
    });
  });

  // Regression (F5): AutoFixOptions carried parentSessionId but no
  // parentOpId — a caller passing the chat session alone would have made
  // the fix worker a CHAT spawn (parentAgentId null), injecting its
  // STATUS block into the user's chat on completion (the preflight bug,
  // 1b2458d0). Both keys must reach runChunkAgent together, exactly as
  // preflight/run-chunk-once thread them.
  it("threads parentSessionId AND parentOpId so the fix worker is an orchestrator child, not a chat spawn", async () => {
    runChunkAgent.mockResolvedValue({ exitCode: 1, stdout: "", durationMs: 1, error: "boom" });

    await runAutoFixWorker({
      projectDir: "/tmp/lax-scenario-project",
      chunk, failedReports: [], allReports: [],
      parentSessionId: "chat-session-1",
      parentOpId: "orchestrator-op-77",
    });

    expect(runChunkAgent.mock.calls[0][0]).toMatchObject({
      parentSessionId: "chat-session-1",
      parentOpId: "orchestrator-op-77",
    });
  });

  // The fix worker ends by calling chunk_report, so its last words are empty.
  // Read as "no output", a fix whose run was then marked failed was thrown
  // away with its work still in the tree.
  it("a worker that reported has finished, and its note is what it said", async () => {
    const chunkReport = { status: "done", doneWhen: "met", note: "the total now rounds half up", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" };
    runChunkAgent.mockResolvedValue({ exitCode: 1, stdout: "", durationMs: 1, error: "ended on a promise", chunkReport });
    const fix = await runAutoFixWorker({ projectDir: "/tmp/lax-scenario-project", chunk, failedReports: [], allReports: [] });
    expect(fix).toMatchObject({ workerCompleted: true, workerReport: "the total now rounds half up", fixSha: "abc1234" });
  });

  it("a worker that neither reported nor said anything did not finish", async () => {
    runChunkAgent.mockResolvedValue({ exitCode: 1, stdout: "", durationMs: 1, error: "boom" });
    const fix = await runAutoFixWorker({ projectDir: "/tmp/lax-scenario-project", chunk, failedReports: [], allReports: [] });
    expect(fix).toMatchObject({ workerCompleted: false, fixSha: null, workerReport: "boom" });
  });
});
