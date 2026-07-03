/**
 * Regression: operations.json read-modify-write clobbers (OP-9).
 *
 * writeOp used a FIXED `.tmp` name shared by every writer — two servers on
 * one ~/.lax could interleave and rename each other's half-written file —
 * and persistOpKeepingSignals / setOpStatus did an unserialized
 * read→mutate→write. Fix: per-write unique tmp + per-opId lockfile
 * (withOpLock) around every RMW, fail-open on a leaked lock.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "./types.js";

// op-store captures OPS_BASE from getLaxDir() at module load, so the env
// override must be in place BEFORE the dynamic imports below.
const dataDir = mkdtempSync(join(tmpdir(), "lax-opstore-"));
process.env.LAX_DATA_DIR = dataDir;

const { writeOp, readOp, setOpStatus, withOpLock } = await import("./op-store.js");
const { persistOpKeepingSignals } = await import("../canonical-loop/op-persist.js");

const opDirOf = (id: string) => join(dataDir, "operations", id);
const lockOf = (id: string) => join(opDirOf(id), "operation.lock");

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
  id,
  type: "freeform",
  task: "do the thing",
  contextPack: {} as Op["contextPack"],
  lane: "interactive" as Op["lane"],
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private" as Op["visibility"],
  status: "pending" as Op["status"],
  createdAt: new Date().toISOString(),
  attemptCount: 0,
  ...over,
});

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("writeOp — per-write unique tmp", () => {
  it("does not route the write through the shared fixed tmp path", () => {
    const id = "op_uniq_tmp";
    writeOp(mkOp(id));
    // Squat on the OLD fixed tmp name. Pre-fix, every writer targeted this
    // exact path, so the write fails (EISDIR) and the update is lost.
    mkdirSync(join(opDirOf(id), "operation.json.tmp"));
    writeOp(mkOp(id, { task: "updated task" }));
    expect(readOp(id)?.task).toBe("updated task");
  });
});

describe("withOpLock — per-opId cross-process lockfile", () => {
  it("holds the lockfile during fn and releases it after", () => {
    const id = "op_lock_basic";
    let heldDuringFn = false;
    const out = withOpLock(id, () => {
      heldDuringFn = existsSync(lockOf(id));
      return 42;
    });
    expect(out).toBe(42);
    expect(heldDuringFn).toBe(true);
    expect(existsSync(lockOf(id))).toBe(false);
  });

  it("is reentrant within the same call stack (no self-stall)", () => {
    const id = "op_lock_reentrant";
    writeOp(mkOp(id));
    const t0 = Date.now();
    const res = withOpLock(id, () => setOpStatus(id, "running"));
    expect(Date.now() - t0).toBeLessThan(400); // no 500ms timeout spin
    expect(res?.status).toBe("running");
  });

  it("releases the lock even when fn throws", () => {
    const id = "op_lock_throw";
    expect(() => withOpLock(id, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockOf(id))).toBe(false);
  });
});

describe("persistOpKeepingSignals — RMW serialized by the per-op lock", () => {
  it("waits for a foreign writer's fresh lock before its read→write, then fails open", () => {
    const id = "op_persist_lock";
    writeOp(mkOp(id));
    // Simulate a second server mid-RMW on the same op.
    writeFileSync(lockOf(id), "99999", { flag: "wx" });
    const t0 = Date.now();
    persistOpKeepingSignals(mkOp(id, { task: "from writer B" }));
    const elapsed = Date.now() - t0;
    // Pre-fix this returned instantly (~0ms) — no serialization at all.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // Fail-open: a leaked lock must not brick persistence.
    expect(readOp(id)?.task).toBe("from writer B");
    rmSync(lockOf(id), { force: true });
  });

  it("still restores control-API signal columns from disk", () => {
    const id = "op_persist_signals";
    const pausedAt = "2026-07-01T00:00:00.000Z";
    writeOp(mkOp(id, { canonical: { pauseRequestedAt: pausedAt } }));
    // Loop-side write from an op object that never saw the pause signal.
    persistOpKeepingSignals(mkOp(id, { status: "running", canonical: {} }));
    const onDisk = readOp(id);
    expect(onDisk?.status).toBe("running");
    expect(onDisk?.canonical?.pauseRequestedAt).toBe(pausedAt);
  });
});
