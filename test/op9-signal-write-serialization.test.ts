/**
 * OP-9: a signal RMW must not lose a concurrent signal another writer set.
 *
 * The finding: two servers share one ~/.lax. The worker's turn-boundary
 * pause-clear did readOp -> set pauseRequestedAt=null -> bare writeOp(op) with
 * no lock, and the control API's opCancel did the same for cancelRequestedAt.
 * A cancel that landed between the worker's read and its write was reverted by
 * the worker's stale in-memory op — the user's cancel was silently lost.
 *
 * The fix routes every signal-column RMW through withOpLock and re-reads the
 * op INSIDE the lock, so each writer merges its own column onto the latest disk
 * state. This test drives the exact interleave: an opCancel commits, then a
 * worker-style pause-clear runs — the cancel must survive.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "lax-op9-"));
process.env.LAX_DATA_DIR = dataDir;

const { writeOp, readOp, withOpLock } = await import("../src/ops/op-store.js");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.LAX_DATA_DIR;
});

function seedOp(id: string) {
  mkdirSync(join(dataDir, "canonical-ops", id), { recursive: true });
  writeOp({
    id,
    type: "chat_turn",
    canonical: { state: "running", pauseRequestedAt: new Date().toISOString() },
  } as unknown as Parameters<typeof writeOp>[0]);
}

describe("OP-9 signal-write serialization", () => {
  it("a worker pause-clear preserves a cancel another process wrote", () => {
    const id = "op_op9race";
    seedOp(id);

    // Worker loaded the op at turn start (pauseRequestedAt set, no cancel).
    const workerView = readOp(id)!;

    // Another server's opCancel commits its column, merged under the lock.
    withOpLock(id, () => {
      const base = readOp(id)!;
      base.canonical!.cancelRequestedAt = new Date().toISOString();
      writeOp(base);
    });

    // Worker now clears the pause using the FIXED pattern: re-read inside the
    // lock and keep every column from disk except the one it clears.
    withOpLock(id, () => {
      const fresh = readOp(id);
      if (fresh?.canonical) workerView.canonical = fresh.canonical;
      workerView.canonical!.pauseRequestedAt = null;
      writeOp(workerView);
    });

    const final = readOp(id)!;
    expect(final.canonical!.pauseRequestedAt).toBeNull();   // pause cleared
    expect(final.canonical!.cancelRequestedAt).toBeTruthy(); // cancel SURVIVED
  });

  it("the pre-fix stale-write pattern would have lost the cancel (guards the regression)", () => {
    const id = "op_op9stale";
    seedOp(id);
    const stale = readOp(id)!; // read before the cancel

    withOpLock(id, () => {
      const base = readOp(id)!;
      base.canonical!.cancelRequestedAt = new Date().toISOString();
      writeOp(base);
    });

    // Simulate the OLD bug: write the stale op without re-reading under lock.
    stale.canonical!.pauseRequestedAt = null;
    writeOp(stale);

    const clobbered = readOp(id)!;
    // Demonstrates the loss the fix prevents: the stale write dropped the cancel.
    expect(clobbered.canonical!.cancelRequestedAt).toBeUndefined();
  });
});
