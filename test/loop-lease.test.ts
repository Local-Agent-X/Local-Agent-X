import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _setLeaseRaceHookForTest,
  acquireLease,
  clearObservedExpiredLease,
  heartbeatLease,
  isLeaseExpired,
  leaseClaimFromOp,
  releaseLease,
  recoverStaleOp,
  resetLeaseConfig,
  setLeaseConfig,
  type LeaseClaim,
} from "../src/canonical-loop/index.js";
import { readOp, writeOp } from "../src/ops/op-store.js";
import { opDir } from "../src/ops/event-log.js";
import { createHarness, makeAndPersistOp, type HarnessContext } from "./canonical-loop/harness.js";

let ctx: HarnessContext;

beforeEach(() => {
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  ctx = createHarness();
});

afterEach(() => {
  ctx.cleanup();
  resetLeaseConfig();
});

function acquire(opId: string, owner: string): LeaseClaim {
  const result = acquireLease(opId, owner);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.claim;
}

function forceExpire(opId: string, expiresAt = new Date(Date.now() - 1_000).toISOString()): void {
  const op = readOp(opId)!;
  op.canonical!.leaseExpiresAt = expiresAt;
  writeOp(op);
}

describe("exact lease claims", () => {
  it("rejects every fresh re-acquire, including the same owner id", () => {
    const op = makeAndPersistOp(ctx);
    const first = acquire(op.id, "w-A");
    expect(acquireLease(op.id, "w-A")).toEqual({ ok: false, reason: "held" });
    expect(acquireLease(op.id, "w-B")).toEqual({ ok: false, reason: "held" });
    expect(leaseClaimFromOp(readOp(op.id))).toEqual(first);
  });

  it("increments generation on takeover and never resets it on release", () => {
    const op = makeAndPersistOp(ctx);
    const first = acquire(op.id, "same-worker");
    forceExpire(op.id);
    const second = acquire(op.id, "same-worker");
    expect(second.generation).toBe(first.generation + 1);
    expect(releaseLease(op.id, second)).toEqual({ ok: true });
    expect(readOp(op.id)?.canonical?.leaseGeneration).toBe(second.generation);
    const third = acquire(op.id, "w-C");
    expect(third.generation).toBe(second.generation + 1);
  });

  it("old same-worker generations cannot heartbeat or release a newer claim", () => {
    const op = makeAndPersistOp(ctx);
    const oldClaim = acquire(op.id, "same-worker");
    forceExpire(op.id);
    const winner = acquire(op.id, "same-worker");
    const expiry = readOp(op.id)!.canonical!.leaseExpiresAt;
    expect(heartbeatLease(op.id, oldClaim)).toEqual({ ok: false, reason: "claim_lost" });
    expect(releaseLease(op.id, oldClaim)).toEqual({ ok: false, reason: "claim_lost" });
    expect(readOp(op.id)?.canonical).toMatchObject({
      leaseOwner: winner.owner,
      leaseGeneration: winner.generation,
      leaseExpiresAt: expiry,
    });
  });

  it("heartbeats and releases only the exact current claim", async () => {
    const op = makeAndPersistOp(ctx);
    const claim = acquire(op.id, "w-A");
    const before = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(heartbeatLease(op.id, claim)).toEqual({ ok: true });
    expect(Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!)).toBeGreaterThan(before);
    expect(releaseLease(op.id, claim)).toEqual({ ok: true });
    expect(readOp(op.id)?.canonical).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseGeneration: claim.generation,
    });
  });

  it("returns typed non-mutating failures for missing ops", () => {
    expect(acquireLease("missing", "w-A")).toEqual({ ok: false, reason: "unknown_op" });
    expect(heartbeatLease("missing", { owner: "w-A", generation: 1 })).toEqual({
      ok: false,
      reason: "unknown_op",
    });
  });

  it("returns lock_unavailable without changing the persisted row", () => {
    const op = makeAndPersistOp(ctx);
    const lock = join(opDir(op.id), "operation.lock");
    writeFileSync(lock, "foreign-holder", { flag: "wx" });
    const before = readFileSync(join(opDir(op.id), "operation.json"), "utf8");
    expect(acquireLease(op.id, "w-A")).toEqual({ ok: false, reason: "lock_unavailable" });
    expect(readFileSync(join(opDir(op.id), "operation.json"), "utf8")).toBe(before);
    rmSync(lock, { force: true });
  });

  it("fails closed instead of wrapping an exhausted generation", () => {
    const op = makeAndPersistOp(ctx);
    const row = readOp(op.id)!;
    row.canonical = { leaseGeneration: Number.MAX_SAFE_INTEGER };
    writeOp(row);
    expect(acquireLease(op.id, "w-A")).toEqual({ ok: false, reason: "generation_exhausted" });
    expect(readOp(op.id)?.canonical).toEqual({ leaseGeneration: Number.MAX_SAFE_INTEGER });
  });
});

describe("exact recovery", () => {
  it("treats malformed expiry with an owner as expired instead of wedging", () => {
    const op = makeAndPersistOp(ctx);
    const claim = acquire(op.id, "w-dead");
    forceExpire(op.id, "not-a-date");
    expect(isLeaseExpired(readOp(op.id))).toBe(true);
    expect(clearObservedExpiredLease(op.id, claim)).toMatchObject({ ok: true, expiredClaim: claim });
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });

  it("deterministically clears a malformed owner shape", () => {
    const op = makeAndPersistOp(ctx);
    const row = readOp(op.id)!;
    row.canonical = {};
    row.canonical!.leaseOwner = 42 as unknown as string;
    row.canonical!.leaseExpiresAt = "invalid";
    writeOp(row);
    expect(clearObservedExpiredLease(op.id, null)).toMatchObject({ ok: true });
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });

  it("a deterministic observation race cannot clear the replacement claim", () => {
    const op = makeAndPersistOp(ctx);
    const observed = acquire(op.id, "w-old");
    forceExpire(op.id);
    _setLeaseRaceHookForTest(point => {
      if (point !== "before_recovery_lock") return;
      _setLeaseRaceHookForTest(null);
      const row = readOp(op.id)!;
      row.canonical!.leaseOwner = "w-winner";
      row.canonical!.leaseGeneration = observed.generation + 1;
      row.canonical!.leaseExpiresAt = new Date(Date.now() + 5_000).toISOString();
      writeOp(row);
    });
    expect(clearObservedExpiredLease(op.id, observed)).toEqual({ ok: false, reason: "claim_changed" });
    expect(leaseClaimFromOp(readOp(op.id))).toEqual({
      owner: "w-winner",
      generation: observed.generation + 1,
    });
  });

  it("a state race fails closed without clearing the observed claim", () => {
    const op = makeAndPersistOp(ctx);
    const claim = acquire(op.id, "w-old");
    const row = readOp(op.id)!;
    row.canonical!.state = "running";
    row.canonical!.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    writeOp(row);
    _setLeaseRaceHookForTest(point => {
      if (point !== "before_recovery_lock") return;
      _setLeaseRaceHookForTest(null);
      const terminal = readOp(op.id)!;
      terminal.canonical!.state = "succeeded";
      writeOp(terminal);
    });
    expect(recoverStaleOp(op.id)).toEqual({ ok: false, kind: "not_running" });
    expect(leaseClaimFromOp(readOp(op.id))).toEqual(claim);
  });
});
