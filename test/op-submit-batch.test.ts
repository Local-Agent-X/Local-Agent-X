/**
 * op_submit_batch — the fan-out launcher (chunk C5).
 *
 * Proves the three load-bearing properties of the bounded worker pool:
 *   (a) N distinct tasks all run and every result is aggregated;
 *   (b) at most `concurrency` ops are ever in flight at once (asserted via a
 *       counting adapter that records the peak concurrent runTurn count);
 *   (c) one failing task does NOT sink the batch — the aggregate reports
 *       1 failed and the rest succeeded.
 *
 * Adapter-faking follows test/canonical-loop-03-happy-path.ts: a lane-default
 * adapter drives every op the tool submits. Each task pins
 * `preferred_provider` to a non-"codex" value so the tool's codex per-op
 * adapter branch never fires and the lane default (our CountingAdapter)
 * serves every op — no dependence on the machine's real settings.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  registerAdapterForOp,
  resetCanonicalRuntime,
  resetScheduler,
  resetBus,
  awaitIdle,
} from "../src/canonical-loop/index.js";
import type {
  Adapter,
  AdapterReport,
  TurnInput,
  TurnResult,
} from "../src/canonical-loop/adapter-contract.js";
import type { ProviderStateEnvelope } from "../src/canonical-loop/types.js";
import { readOp } from "../src/ops/op-store.js";

const runtimeFixture = vi.hoisted(() => ({
  configure: vi.fn(),
}));

vi.mock("../src/ops/tools/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ops/tools/shared.js")>();
  return { ...actual, configureDelegatedRuntime: runtimeFixture.configure };
});

const { opSubmitBatchTool } = await import("../src/ops/tools/op-submit-batch.js");

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdOpIds: string[] = [];

function mkState(): ProviderStateEnvelope {
  return { adapterName: "batch-counting", adapterVersion: "1", providerPayload: null };
}

interface Counter { inFlight: number; max: number; }

/**
 * Lane-default adapter that (1) records the peak number of simultaneously
 * in-flight runTurn calls (the concurrency the pool actually achieved) and
 * (2) fails any task whose seeded user message contains "PLEASE_FAIL".
 */
class CountingAdapter implements Adapter {
  readonly name = "batch-counting";
  readonly version = "1";
  constructor(private readonly ctx: { counter: Counter; holdMs: number }) {}

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    this.ctx.counter.inFlight++;
    this.ctx.counter.max = Math.max(this.ctx.counter.max, this.ctx.counter.inFlight);
    try {
      const userText = input.messages
        .filter(m => m.role === "user")
        .map(m => ((m.content as { text?: string } | null)?.text ?? ""))
        .join(" ");
      await new Promise(r => setTimeout(r, this.ctx.holdMs));
      if (userText.includes("PLEASE_FAIL")) {
        report({ kind: "error", code: "intentional_failure", message: "task was scripted to fail", retryable: false });
        return { providerState: mkState(), terminalReason: "error" };
      }
      report({
        kind: "message_finalized",
        message: { messageId: `m-${Math.random().toString(36).slice(2, 8)}`, role: "assistant", content: { text: "done" } },
      });
      return { providerState: mkState(), terminalReason: "done" };
    } finally {
      this.ctx.counter.inFlight--;
    }
  }

  async abort(): Promise<void> { /* nothing in flight to cancel in these tests */ }
}

function installCountingLaneAdapter(holdMs: number): Counter {
  const counter: Counter = { inFlight: 0, max: 0 };
  // Tasks run on the "interactive" lane (cap 10), so the BATCH concurrency —
  // not the lane cap — is the binding bound in these tests.
  runtimeFixture.configure.mockImplementation(async (op: { id: string; model?: string }) => {
    op.model = "batch-test-model";
    registerAdapterForOp(op.id, () => new CountingAdapter({ counter, holdMs }));
  });
  return counter;
}

/** A single batch task, pinned to the interactive lane + a non-codex provider. */
function task(desc: string) {
  return { task: desc, lane: "interactive", preferred_provider: "test-fake" };
}

interface BatchResult { task: string; opId: string | null; status: string; error?: string; filesChanged: string[]; }
interface BatchMeta { total: number; succeeded: number; failed: number; concurrency: number; results: BatchResult[]; }

async function runBatch(tasks: unknown[], concurrency?: number): Promise<{ isError?: boolean; content: string; meta: BatchMeta }> {
  const res = await opSubmitBatchTool.execute({ tasks, ...(concurrency !== undefined ? { concurrency } : {}) });
  const meta = (res.metadata as { batch: BatchMeta }).batch;
  for (const r of meta.results) if (r.opId) createdOpIds.push(r.opId);
  return { isError: res.isError, content: res.content, meta };
}

beforeEach(() => {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  runtimeFixture.configure.mockReset();
});

afterEach(async () => {
  await awaitIdle(3_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  for (const id of createdOpIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  createdOpIds.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
});

describe("op_submit_batch — fan-out launcher", () => {
  it("(a) runs N distinct tasks and aggregates every result", async () => {
    installCountingLaneAdapter(10);
    const tasks = [1, 2, 3, 4, 5].map(n => task(`distinct batch task number ${n}`));

    const { isError, content, meta } = await runBatch(tasks); // concurrency defaults to 4

    expect(meta.total).toBe(5);
    expect(meta.succeeded).toBe(5);
    expect(meta.failed).toBe(0);
    expect(meta.concurrency).toBe(4); // locked default
    expect(isError).toBe(false);

    // Every task got its own op and a terminal "completed" status.
    expect(meta.results).toHaveLength(5);
    for (const r of meta.results) {
      expect(r.status).toBe("completed");
      expect(typeof r.opId).toBe("string");
    }
    const ids = new Set(meta.results.map(r => r.opId));
    expect(ids.size).toBe(5); // distinct ops, no dedup collapsing them
    expect(content).toContain("5/5 succeeded");
  });

  it("(b) never runs more than `concurrency` ops in flight at once", async () => {
    const counter = installCountingLaneAdapter(40); // hold long enough that the pool saturates
    const tasks = [1, 2, 3, 4, 5, 6].map(n => task(`bounded parallel task ${n}`));

    const { meta } = await runBatch(tasks, 2);

    expect(meta.total).toBe(6);
    expect(meta.succeeded).toBe(6);
    // The binding property: peak in-flight is clamped to the batch concurrency.
    expect(counter.max).toBeLessThanOrEqual(2);
    // And it genuinely parallelized up to the bound (proves it isn't serial).
    expect(counter.max).toBe(2);
  });

  it("(b') a clamped-high concurrency still bounds in flight to the ceiling", async () => {
    const counter = installCountingLaneAdapter(30);
    const tasks = [1, 2, 3, 4, 5].map(n => task(`clamp task ${n}`));

    // 99 clamps to 12; only 5 tasks exist, so peak in-flight is min(12,5)=5.
    const { meta } = await runBatch(tasks, 99);
    expect(meta.concurrency).toBe(12);
    expect(counter.max).toBeLessThanOrEqual(5);
    expect(counter.max).toBeGreaterThanOrEqual(2);
  });

  it("(c) one failing task does not sink the batch — aggregate reports it", async () => {
    installCountingLaneAdapter(10);
    const tasks = [
      task("healthy task one"),
      task("this one must PLEASE_FAIL on purpose"),
      task("healthy task two"),
      task("healthy task three"),
    ];

    const { isError, meta } = await runBatch(tasks, 4);

    expect(meta.total).toBe(4);
    expect(meta.succeeded).toBe(3);
    expect(meta.failed).toBe(1);
    expect(isError).toBe(false); // partial success is not a batch-level error

    const failed = meta.results.filter(r => r.status !== "completed");
    expect(failed).toHaveLength(1);
    expect(failed[0].task).toContain("PLEASE_FAIL");
    expect(failed[0].status).toBe("failed");
    // The other three still completed — the failure didn't abort them.
    expect(meta.results.filter(r => r.status === "completed")).toHaveLength(3);
  });

  it("rejects an empty tasks array without spawning anything", async () => {
    const res = await opSubmitBatchTool.execute({ tasks: [] });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("non-empty");
  });

  it("translates stable batch task keys to durable dependency ids before persistence", async () => {
    const counter = installCountingLaneAdapter(20);
    const tasks = [
      { ...task("dependency root"), task_key: "root" },
      { ...task("dependency left"), task_key: "left", depends_on: ["root"] },
      { ...task("dependency right"), task_key: "right", depends_on: ["root"] },
      { ...task("dependency join"), task_key: "join", depends_on: ["left", "right"] },
    ];

    const { meta } = await runBatch(tasks, 4);
    expect(meta.succeeded).toBe(4);
    const byTask = new Map(meta.results.map((result) => [result.task, result.opId!]));
    expect(readOp(byTask.get("dependency left")!)?.dependsOn)
      .toEqual([byTask.get("dependency root")]);
    expect(readOp(byTask.get("dependency right")!)?.dependsOn)
      .toEqual([byTask.get("dependency root")]);
    expect(readOp(byTask.get("dependency join")!)?.dependsOn)
      .toEqual([byTask.get("dependency left"), byTask.get("dependency right")]);
    expect(counter.max).toBe(2);
  });

  it("rejects duplicate keys and cycles before configuring or persisting any task", async () => {
    installCountingLaneAdapter(5);
    const duplicate = await opSubmitBatchTool.execute({ tasks: [
      { ...task("duplicate one"), task_key: "same" },
      { ...task("duplicate two"), task_key: "same" },
    ] });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain("duplicate batch task_key");
    expect(runtimeFixture.configure).not.toHaveBeenCalled();

    const cycle = await opSubmitBatchTool.execute({ tasks: [
      { ...task("cycle one"), task_key: "one", depends_on: ["two"] },
      { ...task("cycle two"), task_key: "two", depends_on: ["one"] },
    ] });
    expect(cycle.isError).toBe(true);
    expect(cycle.content).toContain("cycle");
    expect(runtimeFixture.configure).not.toHaveBeenCalled();
  });
});
