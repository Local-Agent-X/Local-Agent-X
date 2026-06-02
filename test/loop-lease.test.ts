/**
 * Regression suite for src/canonical-loop/lease.ts owner semantics.
 *
 * Focuses on the lease *primitives* in isolation (no scheduler / worker):
 *   - acquireLease fails when another worker holds a FRESH lease.
 *   - acquireLease succeeds once the holder's lease has EXPIRED.
 *   - heartbeatLease from the wrong workerId is rejected (and is a no-op
 *     on the persisted columns).
 *   - releaseLease is idempotent / non-clobbering when another worker has
 *     already stolen the lease (recovery path) — the original holder does
 *     not wipe the new owner's columns.
 *
 * These cover gaps left by canonical-loop-08-lease-and-crash-recovery.test.ts,
 * which asserts the live crash-recovery flow but does not pin the standalone
 * "expired lease is acquirable" path nor the steal-then-release no-op.
 *
 * Reuses the canonical-loop store fixture (createHarness / makeAndPersistOp)
 * so ops land on disk via writeOp without invoking the loop runtime. Lease
 * columns are driven purely through the public primitives plus direct disk
 * edits to synthesize expiry — matching the idiom in the Issue 08 suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireLease,
  heartbeatLease,
  releaseLease,
  isLeaseExpired,
  setLeaseConfig,
  resetLeaseConfig,
} from "../src/canonical-loop/index.js";
import { readOp, writeOp } from "../src/ops/op-store.js";

import { createHarness, makeAndPersistOp, type HarnessContext } from "./canonical-loop/harness.js";

let ctx: HarnessContext;

beforeEach(() => {
  // Compress the lease cycle so synthesized-expiry math stays small and
  // the test never leans on the 30s production default.
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
  ctx = createHarness();
});

afterEach(() => {
  ctx.cleanup();
  resetLeaseConfig();
});

/** Push the op's leaseExpiresAt into the past on disk. */
function forceExpire(opId: string): void {
  const op = readOp(opId)!;
  op.canonical!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  writeOp(op);
}

describe("acquireLease owner semantics", () => {
  it("fails when another worker holds a fresh lease, leaving the owner intact", () => {
    const op = makeAndPersistOp(ctx);

    expect(acquireLease(op.id, "w-A")).toBe(true);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-A");

    // Fresh lease held by A — B cannot steal it.
    expect(acquireLease(op.id, "w-B")).toBe(false);
    const after = readOp(op.id);
    expect(after?.canonical?.leaseOwner).toBe("w-A");
    expect(after?.workerId).toBe("w-A");
  });

  it("re-acquire by the same owner refreshes the expiry (reuse path)", async () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);
    const first = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    await new Promise(r => setTimeout(r, 20));
    expect(acquireLease(op.id, "w-A")).toBe(true);
    const second = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    expect(second).toBeGreaterThan(first);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-A");
  });

  it("an EXPIRED lease is acquirable by a different worker", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    // The lease is fresh: it is NOT yet expired.
    expect(isLeaseExpired(readOp(op.id))).toBe(false);

    // Time passes / A dies — the lease lapses.
    forceExpire(op.id);
    expect(isLeaseExpired(readOp(op.id))).toBe(true);

    // B steals the now-expired lease.
    expect(acquireLease(op.id, "w-B")).toBe(true);
    const after = readOp(op.id);
    expect(after?.canonical?.leaseOwner).toBe("w-B");
    expect(after?.workerId).toBe("w-B");
    expect(isLeaseExpired(after)).toBe(false);
  });

  it("acquires when no lease has ever been set", () => {
    const op = makeAndPersistOp(ctx);
    // Persisted op from the fixture has no lease columns yet.
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();

    expect(acquireLease(op.id, "w-first")).toBe(true);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-first");
  });

  it("returns false for an op id that does not exist", () => {
    expect(acquireLease("op_lease_missing", "w-A")).toBe(false);
  });
});

describe("heartbeatLease owner semantics", () => {
  it("rejected from the wrong workerId and does not touch the persisted expiry", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);
    const expiryBefore = readOp(op.id)!.canonical!.leaseExpiresAt!;

    // A different worker tries to heartbeat — must be rejected.
    expect(heartbeatLease(op.id, "w-IMPOSTER")).toBe(false);

    const after = readOp(op.id);
    expect(after?.canonical?.leaseOwner).toBe("w-A");
    // No-op: the expiry the rightful owner set is untouched.
    expect(after?.canonical?.leaseExpiresAt).toBe(expiryBefore);
  });

  it("rejected after another worker steals an expired lease", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    // A's lease lapses; B re-acquires.
    forceExpire(op.id);
    expect(acquireLease(op.id, "w-B")).toBe(true);

    // A (the ghost) tries to heartbeat — must lose to B.
    expect(heartbeatLease(op.id, "w-A")).toBe(false);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-B");
  });

  it("extends the expiry forward for the rightful owner", async () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);
    const before = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    await new Promise(r => setTimeout(r, 20));
    expect(heartbeatLease(op.id, "w-A")).toBe(true);
    const after = Date.parse(readOp(op.id)!.canonical!.leaseExpiresAt!);

    expect(after).toBeGreaterThan(before);
  });

  it("returns false for an op id that does not exist", () => {
    expect(heartbeatLease("op_lease_missing", "w-A")).toBe(false);
  });
});

describe("releaseLease owner semantics", () => {
  it("releases only when the caller still owns the lease", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    // Non-owner release is a no-op.
    expect(releaseLease(op.id, "w-other")).toBe(false);
    expect(readOp(op.id)?.canonical?.leaseOwner).toBe("w-A");

    // Owner release clears the columns.
    expect(releaseLease(op.id, "w-A")).toBe(true);
    const after = readOp(op.id);
    expect(after?.canonical?.leaseOwner ?? null).toBeNull();
    expect(after?.canonical?.leaseExpiresAt ?? null).toBeNull();
    expect(after?.workerId ?? null).toBeNull();
  });

  it("is a non-clobbering no-op when another worker already stole the lease", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    // Recovery path: A's lease expired and B took over.
    forceExpire(op.id);
    expect(acquireLease(op.id, "w-B")).toBe(true);
    const bExpiry = readOp(op.id)!.canonical!.leaseExpiresAt!;

    // A's finally block fires releaseLease late. It must NOT clobber B.
    expect(releaseLease(op.id, "w-A")).toBe(false);
    const after = readOp(op.id);
    expect(after?.canonical?.leaseOwner).toBe("w-B");
    expect(after?.canonical?.leaseExpiresAt).toBe(bExpiry);
    expect(after?.workerId).toBe("w-B");
  });

  it("a double release by the same owner is idempotent (second is a no-op)", () => {
    const op = makeAndPersistOp(ctx);
    expect(acquireLease(op.id, "w-A")).toBe(true);

    expect(releaseLease(op.id, "w-A")).toBe(true);
    // Second release: owner is already null, so it returns false.
    expect(releaseLease(op.id, "w-A")).toBe(false);
    expect(readOp(op.id)?.canonical?.leaseOwner ?? null).toBeNull();
  });

  it("returns false for an op id that does not exist", () => {
    expect(releaseLease("op_lease_missing", "w-A")).toBe(false);
  });
});
