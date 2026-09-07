/**
 * op_submit and op_submit_batch — a PARTIAL child is unfinished, not failed.
 *
 * A worker-lane op that stops at a dry checkpoint (checkpoint-stop.ts) ends
 * `succeeded / iteration_checkpoint` and reaches its parent as OpResult
 * status "partial" (await-op.ts). op_wait already rendered that correctly
 * (PARTIAL line first, child's final text after, isError:false). op_submit —
 * which IS op_submit_async + op_wait in one call — returned isError:true with
 * only the synthesized finalSummary, and op_submit_batch counted a partial
 * task as failed. Both now share op_wait's rendering (op-result-summary.ts)
 * and count partial on its own.
 *
 * Real seam: a genuine worker drives a scripted adapter against a live tool
 * dispatcher with the REAL loop-detection middleware, so the dry stop is
 * produced by production code, not seeded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { setMiddlewareStack, _resetMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { loopDetectionMiddleware } from "../src/canonical-loop/middlewares/loop-detection.js";
import { getRuntimeConfig, setRuntimeConfig } from "../src/config.js";
import {
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  awaitIdle,
  resetBus,
  setLeaseConfig,
  resetLeaseConfig,
  setToolDispatcher,
} from "../src/canonical-loop/index.js";
import type { Op } from "../src/ops/types.js";
import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";

const runtimeFixture = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("../src/ops/tools/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ops/tools/shared.js")>();
  return { ...actual, configureDelegatedRuntime: runtimeFixture.configure };
});

const { opSubmitTool } = await import("../src/ops/tools/op-submit.js");
const { opSubmitBatchTool } = await import("../src/ops/tools/op-submit-batch.js");

const OPS_BASE = join(homedir(), ".lax", "operations");
const created: string[] = [];
const ORIGINAL_CONFIG = getRuntimeConfig();

/** Per-op adapter chosen by the task text: a scripted spin that the dry
 *  checkpoint will stop (PLEASE_PARTIAL), a scripted failure (PLEASE_FAIL),
 *  or a one-turn finish. */
function installTaskScriptedAdapters(): void {
  runtimeFixture.configure.mockImplementation(async (op: Op) => {
    created.push(op.id);
    op.model = "partial-test-model";
    if (op.task.includes("PLEASE_PARTIAL")) {
      // Distinct arguments, identical results (dispatcher below): no exact-
      // repeat and a constant shape (no cycle), so the worker-lane pivot
      // ceiling never arms and the DRY CHECKPOINT is what ends the op — the
      // partial we are testing, not a loop abort.
      const script = Array.from({ length: 20 }, (_, i) =>
        scriptTurn({ text: `still going (${i})`, toolCalls: [{ toolCallId: `p-${op.id}-${i}`, tool: "search", args: { q: `q-${i}` } }] }),
      );
      registerAdapterForOp(op.id, () => new FakeAdapter({ script }));
    } else if (op.task.includes("PLEASE_FAIL")) {
      registerAdapterForOp(op.id, () => new FakeAdapter({
        script: [scriptTurn({ errorReports: [{ code: "intentional_failure", message: "scripted to fail", retryable: false }], terminal: "error" })],
      }));
    } else {
      registerAdapterForOp(op.id, () => new FakeAdapter({ script: [scriptTurn({ text: "all done", terminal: "done" })] }));
    }
  });
}

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  setMiddlewareStack([loopDetectionMiddleware]);
  // Decide the stop by evidence alone — the spend ceiling reads the real
  // ~/.lax ledger (see test/worker-honors-iteration-budget.test.ts).
  setRuntimeConfig({ ...ORIGINAL_CONFIG, dailyBudgetUsd: 0, sessionBudgetUsd: 0 });
  runtimeFixture.configure.mockReset();
  installTaskScriptedAdapters();
  // Identical result every call: loop-detection's progress counter never
  // moves after the first, so the op is dry at its second and third checkpoint.
  setToolDispatcher({
    async dispatch(call) {
      return { toolCallId: call.toolCallId, status: "ok", result: { ok: true }, durationMs: 0 };
    },
  });
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  _resetMiddlewareStack();
  setRuntimeConfig(ORIGINAL_CONFIG);
  for (const id of created) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  created.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

const submitArgs = (task: string) => ({ task, lane: "build", max_iterations: 3, preferred_provider: "test-fake" });

describe("op_submit — a checkpoint-stopped child", () => {
  it("is not an error, opens with the PARTIAL line, then the child's final text (op_wait's rendering)", async () => {
    const res = await opSubmitTool.execute(submitArgs("PLEASE_PARTIAL: spin on one search"));
    const opId = created[0];

    expect(res.isError).toBe(false);
    expect(res.content.startsWith(`PARTIAL — child op ${opId} stopped at a checkpoint after `)).toBe(true);
    expect(res.content).toContain("(reason: dry-checkpoints");
    expect(res.content).toContain(`op ${opId} partial in `);
    // The child's own final text follows the PARTIAL line — never in front of it.
    const partialAt = res.content.indexOf("PARTIAL — child op");
    const textAt = res.content.indexOf("still going");
    expect(textAt).toBeGreaterThan(partialAt);
  });

  it("a finished child still renders completed with its final text", async () => {
    const res = await opSubmitTool.execute(submitArgs("finish immediately"));
    const opId = created[0];
    expect(res.isError).toBe(false);
    expect(res.content).toContain(`op ${opId} completed in `);
    expect(res.content).toContain("all done");
    expect(res.content).not.toContain("PARTIAL");
  });

  it("a failed child is still an error", async () => {
    const res = await opSubmitTool.execute(submitArgs("PLEASE_FAIL now"));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("failed");
  });
});

describe("op_submit_batch — partial is counted on its own", () => {
  it("reports N completed, N partial, N failed and is not an error while anything landed", async () => {
    const res = await opSubmitBatchTool.execute({
      tasks: [
        submitArgs("batch task that finishes"),
        submitArgs("PLEASE_PARTIAL: batch task that spins"),
        submitArgs("PLEASE_FAIL: batch task that dies"),
      ],
      concurrency: 3,
    });
    const meta = (res.metadata as { batch: { succeeded: number; partial: number; failed: number; total: number; results: { status: string; finalSummary: string; opId: string }[] } }).batch;
    for (const r of meta.results) if (r.opId) created.push(r.opId);

    expect(meta).toMatchObject({ total: 3, succeeded: 1, partial: 1, failed: 1 });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("Batch: 1/3 completed, 1 partial, 1 failed");
    const partialTask = meta.results.find(r => r.status === "partial")!;
    expect(partialTask.finalSummary.startsWith(`PARTIAL — child op ${partialTask.opId} stopped at a checkpoint`)).toBe(true);
    expect(res.content).toContain(`[partial] ${partialTask.opId}`);
    // The tool description promises the PARTIAL line is relayed; the model
    // reads CONTENT, so the line must follow the task's own row there — not
    // live only in metadata.batch.results.
    const row = res.content.indexOf(`[partial] ${partialTask.opId}`);
    const partialLine = res.content.indexOf(`PARTIAL — child op ${partialTask.opId} stopped at a checkpoint`);
    expect(partialLine).toBeGreaterThan(row);
    // The completed and failed rows carry no PARTIAL line of their own.
    expect(res.content.match(/PARTIAL — child op/g)).toHaveLength(1);
  });

  it("a batch whose only landed work is partial is not an error either", async () => {
    const res = await opSubmitBatchTool.execute({
      tasks: [submitArgs("PLEASE_PARTIAL: only task"), submitArgs("PLEASE_FAIL: other task")],
      concurrency: 2,
    });
    const meta = (res.metadata as { batch: { succeeded: number; partial: number; failed: number; results: { opId: string }[] } }).batch;
    for (const r of meta.results) if (r.opId) created.push(r.opId);
    expect(meta).toMatchObject({ succeeded: 0, partial: 1, failed: 1 });
    expect(res.isError).toBe(false);
  });
});
