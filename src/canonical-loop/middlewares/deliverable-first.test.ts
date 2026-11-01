import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Every path the request names resolves into this test's folder.
const dir = mkdtempSync(join(tmpdir(), "deliverable-first-"));
vi.mock("../../workspace/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workspace/paths.js")>()),
  resolveAgentPath: (p: string) => join(dir, basename(p)),
}));

import { deliverableFirstMiddleware, deliverableNudge } from "./deliverable-first.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { clearMiddlewareStateForOp } from "./state.js";

const REQUEST = "Read /app/task_file/input.csv and write the plans to /app/task_file/output_data/plan_b1.jsonl and /app/task_file/output_data/plan_b2.jsonl.";
// No model: the default tier restates the goal at turn 6, so the nudge comes at 12.
const at = (turnIdx: number, opId: string) =>
  makeCanonicalLoopContext({ turnIdx, currentUserMessage: REQUEST, model: "", op: { id: opId } });

afterEach(() => { for (const id of ["op-a", "op-b", "op-c"]) clearMiddlewareStateForOp(id); });

describe("deliverable-first", () => {
  it("waits until twice the restate turn, then names the outputs still missing, once", () => {
    writeFileSync(join(dir, "input.csv"), "x");
    expect(deliverableFirstMiddleware.beforeTurn!(at(11, "op-a"))).toEqual({ kind: "continue" });
    const r = deliverableFirstMiddleware.beforeTurn!(at(12, "op-a"));
    expect(r).toEqual({ kind: "nudge", reason: "deliverable-first", message: deliverableNudge([
      "/app/task_file/output_data/plan_b1.jsonl", "/app/task_file/output_data/plan_b2.jsonl",
    ]) });
    expect(deliverableFirstMiddleware.beforeTurn!(at(13, "op-a"))).toEqual({ kind: "continue" });
  });

  it("says nothing when every named file is on disk", () => {
    writeFileSync(join(dir, "plan_b1.jsonl"), "{}"); writeFileSync(join(dir, "plan_b2.jsonl"), "{}");
    expect(deliverableFirstMiddleware.beforeTurn!(at(12, "op-b"))).toEqual({ kind: "continue" });
    rmSync(join(dir, "plan_b1.jsonl")); rmSync(join(dir, "plan_b2.jsonl"));
  });

  it("names only what is still missing", () => {
    writeFileSync(join(dir, "plan_b1.jsonl"), "{}");
    const r = deliverableFirstMiddleware.beforeTurn!(at(20, "op-c"));
    expect(r).toMatchObject({ kind: "nudge", message: expect.stringContaining("plan_b2.jsonl, and it is not on disk yet") });
    rmSync(join(dir, "plan_b1.jsonl"));
  });
});
