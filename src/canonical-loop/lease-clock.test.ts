/**
 * Lease expiry is judged by one clock a test can set. A test that needs an
 * expired lease moves the clock; it never shortens the lease under the real
 * clock, where any stall longer than the lease (routine on a slow CI runner)
 * expires a healthy worker's lease mid-turn.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-lease-clock-"));
process.env.LAX_DATA_DIR = dataDir;

const { newOpId, readOp, writeOp } = await import("../ops/op-store.js");
const {
  acquireLease, getLeaseConfig, heartbeatLease, isLeaseExpired, resetLeaseConfig, setLeaseClock,
} = await import("./lease.js");

function persistOp(label: string): Op {
  const op = {
    id: newOpId(`lease_clock_${label}`),
    type: "freeform",
    task: label,
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    canonical: { state: "running" },
  } as Op;
  writeOp(op);
  return op;
}

afterEach(() => resetLeaseConfig());
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("lease time under the lease clock", () => {
  it("a default lease expires when the clock moves past it, with no waiting", () => {
    let now = Date.UTC(2026, 0, 1);
    setLeaseClock(() => now);
    const op = persistOp("expires");
    const acquired = acquireLease(op.id, "w1");
    expect(acquired.ok).toBe(true);

    const { leaseDurationMs } = getLeaseConfig();
    expect(Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!)).toBe(now + leaseDurationMs);
    expect(isLeaseExpired(readOp(op.id))).toBe(false);

    now += leaseDurationMs - 1;
    expect(isLeaseExpired(readOp(op.id))).toBe(false);
    now += 1;
    expect(isLeaseExpired(readOp(op.id))).toBe(true);
    expect(acquireLease(op.id, "w2").ok).toBe(true);
  });

  it("a heartbeat stamps the new expiry from the clock, and resetLeaseConfig returns to real time", () => {
    let now = Date.UTC(2026, 0, 1);
    setLeaseClock(() => now);
    const op = persistOp("beats");
    const acquired = acquireLease(op.id, "w1");
    if (!acquired.ok) throw new Error("lease not acquired");

    now += 45_000;
    expect(heartbeatLease(op.id, acquired.claim)).toEqual({ ok: true });
    expect(Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!)).toBe(now + getLeaseConfig().leaseDurationMs);

    resetLeaseConfig();
    // Judged by the real clock again: a lease stamped in 2026-01 is long gone.
    expect(isLeaseExpired(readOp(op.id))).toBe(true);
  });
});
