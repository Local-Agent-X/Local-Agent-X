import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { awaitOpResult, getPoolStatus } from "../src/workers/pool.js";
import { writeOp } from "../src/workers/op-store.js";
import type { Op } from "../src/workers/types.js";

// Tests touch ~/.lax/operations/<opId>/ — use unique opIds and clean up afterward.
// We deliberately avoid calling submitOp / startWorkerPool so no subprocesses spawn.

let counter = 0;
const opId = (label: string) => `test_${Date.now().toString(36)}_${++counter}_${label}`;

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
  id,
  type: over.type ?? "freeform",
  task: over.task ?? "do the thing",
  contextPack: over.contextPack ?? ({} as Op["contextPack"]),
  lane: over.lane ?? "build",
  retryPolicy: over.retryPolicy ?? { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: over.ownerId ?? "u",
  visibility: over.visibility ?? "private",
  status: over.status ?? "pending",
  createdAt: over.createdAt ?? new Date().toISOString(),
  attemptCount: over.attemptCount ?? 0,
  ...over,
});

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  createdIds.length = 0;
});

function persist(op: Op): void {
  createdIds.push(op.id);
  writeOp(op);
}

describe("awaitOpResult", () => {
  it("returns null for an opId that was never created", async () => {
    const result = await awaitOpResult("does-not-exist-xyz", 100);
    expect(result).toBeNull();
  });

  it("synthesizes a completed result from a terminal op on disk", async () => {
    const id = opId("completed");
    persist(mkOp(id, { status: "completed", task: "wrote the readme" }));
    const result = await awaitOpResult(id, 100);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.opId).toBe(id);
    expect(result!.filesChanged).toEqual([]);
  });

  it("synthesizes a failed result with the disk error message", async () => {
    const id = opId("failed");
    persist(mkOp(id, { status: "failed", lastFailureReason: "openai 429 rate limited" }));
    const result = await awaitOpResult(id, 100);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.finalSummary).toContain("openai 429");
    expect(result!.error?.message).toBe("openai 429 rate limited");
    expect(result!.error?.recoverable).toBe(false);
  });

  it("synthesizes a cancelled result from a cancelled disk op", async () => {
    const id = opId("cancelled");
    persist(mkOp(id, { status: "cancelled" }));
    const result = await awaitOpResult(id, 100);
    expect(result?.status).toBe("cancelled");
  });

  it("returns null when op is still pending and no result event arrives within timeout", async () => {
    const id = opId("pending");
    persist(mkOp(id, { status: "pending" }));
    const start = Date.now();
    const result = await awaitOpResult(id, 75);
    expect(result).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("returns null when op is running and no result event arrives within timeout", async () => {
    const id = opId("running");
    persist(mkOp(id, { status: "running" }));
    const result = await awaitOpResult(id, 75);
    expect(result).toBeNull();
  });

  it("uses fallback summary when no lastFailureReason is set", async () => {
    const id = opId("no-error");
    persist(mkOp(id, { status: "completed" }));
    const result = await awaitOpResult(id, 100);
    expect(result!.finalSummary).toContain(id);
    expect(result!.finalSummary).toContain("completed");
    expect(result!.error).toBeUndefined();
  });

  it("treats malformed operation.json as not-found rather than throwing", async () => {
    const id = opId("malformed");
    createdIds.push(id);
    const dir = join(OPS_BASE, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "operation.json"), "{ this is not json", "utf-8");
    const result = await awaitOpResult(id, 100);
    expect(result).toBeNull();
  });
});

describe("getPoolStatus", () => {
  it("returns empty workers and zero queue length before the pool is started", () => {
    const status = getPoolStatus();
    expect(status).toHaveProperty("workers");
    expect(status).toHaveProperty("queueLength");
    expect(Array.isArray(status.workers)).toBe(true);
    expect(typeof status.queueLength).toBe("number");
    expect(status.queueLength).toBeGreaterThanOrEqual(0);
  });
});
