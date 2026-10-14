// protocol(action:"rollback_undo") used to print the snapshot and change
// nothing: the execution's progress tracker (same executionId) stayed at the
// step it had reached. A snapshot now carries the progress at snapshot time
// and undo puts it back.
import { describe, expect, it } from "vitest";
import { completeStep, getProgress, startExecution } from "./progress.js";
import { createRollbackSession, createRollbackTools, rollbackLast, rollbackToStep, saveSnapshot } from "./rollback.js";

function trackedExecution() {
  const prog = startExecution("deploy", ["build", "test", "ship"]);
  createRollbackSession(prog.executionId, "deploy");
  return prog.executionId;
}

describe("rollback restores execution progress", () => {
  it("rollbackToStep rewinds the tracker to the snapshot's step", () => {
    const id = trackedExecution();
    saveSnapshot(id, "build", { artifact: null }, "before build");
    completeStep(id, "built");
    saveSnapshot(id, "test", { artifact: "a.tgz" }, "before test");
    completeStep(id, "tested");
    expect(getProgress(id)!.currentStepIndex).toBe(2);

    const snap = rollbackToStep(id, "build");
    expect(snap?.state).toEqual({ artifact: null });
    const prog = getProgress(id)!;
    expect(prog.currentStepIndex).toBe(0);
    expect(prog.steps.map(s => s.status)).toEqual(["running", "pending", "pending"]);
    expect(prog.status).toBe("running");
  });

  it("rollbackLast steps back one snapshot and the tool reports the rewound progress", async () => {
    const id = trackedExecution();
    saveSnapshot(id, "build", {}, "before build");
    completeStep(id);
    saveSnapshot(id, "test", {}, "before test");
    completeStep(id);
    completeStep(id);
    expect(getProgress(id)!.status).toBe("completed");

    expect(rollbackLast(id)?.stepId).toBe("build");
    expect(getProgress(id)!.currentStepIndex).toBe(0);
    expect(getProgress(id)!.status).toBe("running");

    const undo = createRollbackTools().find(t => t.name === "protocol_rollback_undo")!;
    const res = await undo.execute({ executionId: id, stepId: "build" });
    expect(res.content).toContain("Execution progress rewound: step 1/3");
  });

  it("a snapshot taken with no tracked execution still returns its state", () => {
    createRollbackSession("exec-untracked", "deploy");
    saveSnapshot("exec-untracked", "s1", { k: 1 }, "no progress");
    expect(rollbackToStep("exec-untracked", "s1")).toMatchObject({ state: { k: 1 } });
    expect(getProgress("exec-untracked")).toBeUndefined();
  });
});
