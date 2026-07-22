/**
 * Regression: operations.json read-modify-write clobbers (OP-9).
 *
 * writeOp used a FIXED `.tmp` name shared by every writer — two servers on
 * one ~/.lax could interleave and rename each other's half-written file —
 * and persistOpKeepingSignals / setOpStatus did an unserialized
 * read→mutate→write. Fix: per-write unique tmp + per-opId lockfile
 * (withOpLock) around every RMW, fail-open on a leaked lock.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Op } from "./types.js";

const fsReads = vi.hoisted(() => ({ operations: 0 }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith("operation.json")) fsReads.operations++;
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

// op-store captures OPS_BASE from getLaxDir() at module load, so the env
// override must be in place BEFORE the dynamic imports below.
const dataDir = mkdtempSync(join(tmpdir(), "lax-opstore-"));
process.env.LAX_DATA_DIR = dataDir;

const { writeOp, readOp, listRecentOps, setOpStatus, tryWithOpLock, withOpLock, newOpId, sanitizeIdPrefix } = await import("./op-store.js");
const { persistOpKeepingSignals } = await import("../canonical-loop/index.js");

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

describe("listRecentOps — persistence-level bound", () => {
  it("decodes no more operation payloads than the requested limit", () => {
    for (let index = 0; index < 300; index++) writeOp(mkOp(`op_recent_${index}`));
    fsReads.operations = 0;
    const recent = listRecentOps(256);
    expect(recent).toHaveLength(256);
    expect(fsReads.operations).toBe(256);
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

  it("release removes only its exact token, never a replacement lock", () => {
    const id = "op_lock_token_release";
    withOpLock(id, () => {
      rmSync(lockOf(id), { recursive: true, force: true });
      mkdirSync(lockOf(id));
      writeFileSync(join(lockOf(id), "replacement-token"), "replacement");
    });
    expect(existsSync(join(lockOf(id), "replacement-token"))).toBe(true);
    rmSync(lockOf(id), { recursive: true, force: true });
  });

  it("strict try-lock returns without running the mutation on contention", () => {
    const id = "op_lock_strict_contention";
    writeOp(mkOp(id));
    writeFileSync(lockOf(id), "legacy-live-holder", { flag: "wx" });
    let mutated = false;
    expect(tryWithOpLock(id, () => { mutated = true; })).toEqual({ acquired: false });
    expect(mutated).toBe(false);
    rmSync(lockOf(id), { force: true });
  });

  it("reclaims a stale crashed token but never steals an old live token", () => {
    const crashed = "op_lock_crashed";
    writeOp(mkOp(crashed));
    mkdirSync(lockOf(crashed));
    writeFileSync(join(lockOf(crashed), "dead-token"), JSON.stringify({ token: "dead-token", pid: 999_999_999 }));
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockOf(crashed), old, old);
    expect(tryWithOpLock(crashed, () => "recovered")).toEqual({ acquired: true, value: "recovered" });
    expect(existsSync(lockOf(crashed))).toBe(false);

    const live = "op_lock_live";
    writeOp(mkOp(live));
    mkdirSync(lockOf(live));
    writeFileSync(join(lockOf(live), "live-token"), JSON.stringify({ token: "live-token", pid: process.pid }));
    utimesSync(lockOf(live), old, old);
    expect(tryWithOpLock(live, () => "stolen")).toEqual({ acquired: false });
    expect(existsSync(join(lockOf(live), "live-token"))).toBe(true);
    rmSync(lockOf(live), { recursive: true, force: true });
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

describe("newOpId — model-controlled op type cannot escape the operations root", () => {
  it("strips path metacharacters from a traversal-laden op type prefix", () => {
    // `type` is model-controlled at op_submit_async; op-store mints the id as
    // `op_${type}` which becomes a path segment under ~/.lax/operations.
    const id = newOpId("op_../../../../etc/passwd");
    expect(id).not.toContain("..");
    expect(id).not.toContain("/");
    expect(id).not.toContain("\\");
    // Joining the sanitized id stays strictly inside the operations root.
    const dir = opDirOf(id);
    const root = join(dataDir, "operations");
    expect(dir.startsWith(root + sep)).toBe(true);
  });

  it("leaves an ordinary op type prefix byte-for-byte intact (no regression)", () => {
    const id = newOpId("op_build_app");
    expect(id).toMatch(/^op_build_app_[0-9a-f]{16}$/);
  });
});

describe("sanitizeIdPrefix", () => {
  it("collapses separators, drive colons, dots and NULs to underscores", () => {
    expect(sanitizeIdPrefix("op_../../x")).toBe("op__x");
    expect(sanitizeIdPrefix("op_C:\\Windows")).toBe("op_C_Windows");
    expect(sanitizeIdPrefix("op_a\0b")).toBe("op_a_b");
  });

  it("falls back when the prefix has no safe characters left", () => {
    expect(sanitizeIdPrefix("../../")).toBe("op");
    expect(sanitizeIdPrefix("///", "fallback")).toBe("fallback");
  });

  it("keeps already-safe prefixes unchanged", () => {
    expect(sanitizeIdPrefix("op_chat_turn")).toBe("op_chat_turn");
  });
});
