// Regression for AB-3: the scenario-fix worker was spawned without projectDir,
// so it ran from the LAX repo root and could not touch the project it was
// meant to repair — the re-score then failed identically. It must receive the
// project dir.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runChunkAgent } = vi.hoisted(() => ({ runChunkAgent: vi.fn() }));
vi.mock("../agents/chunk-runner.js", () => ({ runChunkAgent }));

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
});
