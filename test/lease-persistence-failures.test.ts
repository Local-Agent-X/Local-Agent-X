import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLease,
  heartbeatLease,
  leaseClaimFromOp,
  recoverStaleOp,
  releaseLease,
  resetLeaseConfig,
  setLeaseConfig,
  type LeaseClaim,
} from "../src/canonical-loop/index.js";
import {
  _setStrictOpWriteFailureForTest,
  readOp,
  writeOp,
} from "../src/ops/op-store.js";
import { opDir } from "../src/ops/event-log.js";
import { createHarness, makeAndPersistOp, type HarnessContext } from "./canonical-loop/harness.js";

let ctx: HarnessContext;
const injected = Object.assign(new Error("injected strict persistence failure"), { code: "EIO" });

beforeEach(() => {
  ctx = createHarness();
  setLeaseConfig({ leaseDurationMs: 100, heartbeatIntervalMs: 25 });
});

afterEach(() => {
  _setStrictOpWriteFailureForTest(null);
  resetLeaseConfig();
  ctx.cleanup();
});

function acquire(opId: string, owner: string): LeaseClaim {
  const result = acquireLease(opId, owner);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.claim;
}

function bytes(opId: string): string {
  return readFileSync(join(opDir(opId), "operation.json"), "utf8");
}

function expectNoTmp(opId: string): void {
  expect(readdirSync(opDir(opId)).filter(name => name.endsWith(".tmp"))).toEqual([]);
}

describe.each(["before_write", "before_rename"] as const)("strict failure at %s", point => {
  it.each(["acquire", "heartbeat", "release"] as const)(
    "%s reports persistence_failed and leaves the durable claim unchanged",
    action => {
      const op = makeAndPersistOp(ctx);
      const claim = action === "acquire" ? null : acquire(op.id, "owner-A");
      const before = bytes(op.id);
      _setStrictOpWriteFailureForTest(injected, point);

      const result = action === "acquire"
        ? acquireLease(op.id, "owner-B")
        : action === "heartbeat"
          ? heartbeatLease(op.id, claim!)
          : releaseLease(op.id, claim!);

      expect(result).toEqual({ ok: false, reason: "persistence_failed" });
      expect(bytes(op.id)).toBe(before);
      expectNoTmp(op.id);
    },
  );
});

describe("recovery persistence fencing", () => {
  it("does not consume an attempt or requeue when the state rename fails", () => {
    const op = makeAndPersistOp(ctx);
    const claim = acquire(op.id, "dead-owner");
    const crashed = readOp(op.id)!;
    crashed.canonical!.state = "running";
    crashed.canonical!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeOp(crashed);

    _setStrictOpWriteFailureForTest(injected, "before_rename", 2);
    expect(recoverStaleOp(op.id)).toMatchObject({
      ok: false,
      kind: "persistence_failed",
      expiredWorkerId: claim.owner,
    });
    expect(readOp(op.id)).toMatchObject({
      attemptCount: 0,
      canonical: { state: "running", leaseOwner: null, leaseExpiresAt: null },
    });
    expectNoTmp(op.id);

    _setStrictOpWriteFailureForTest(null);
    expect(recoverStaleOp(op.id)).toMatchObject({ ok: true, kind: "recovered" });
    expect(readOp(op.id)).toMatchObject({ attemptCount: 1, canonical: { state: "queued" } });
  });

  it("a failed takeover cannot expose or clobber a second owner", () => {
    const op = makeAndPersistOp(ctx);
    const old = acquire(op.id, "same-owner");
    const expired = readOp(op.id)!;
    expired.canonical!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeOp(expired);

    _setStrictOpWriteFailureForTest(injected, "before_rename");
    expect(acquireLease(op.id, "same-owner")).toEqual({ ok: false, reason: "persistence_failed" });
    expect(leaseClaimFromOp(readOp(op.id))).toEqual(old);

    _setStrictOpWriteFailureForTest(null);
    const replacement = acquire(op.id, "same-owner");
    expect(replacement.generation).toBe(old.generation + 1);
    expect(heartbeatLease(op.id, old)).toEqual({ ok: false, reason: "claim_lost" });
    expect(releaseLease(op.id, old)).toEqual({ ok: false, reason: "claim_lost" });
    expect(leaseClaimFromOp(readOp(op.id))).toEqual(replacement);
  });
});
