/**
 * What a recovery pass costs on a store of mostly finished ops. The periodic
 * janitor read and parsed every record on each pass (449 MB on the owner's
 * machine, about once a minute, 2026-11-22). A pass now looks only at the ops
 * still in flight, and so do the other questions that used to read the store.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

// op-store binds its base dir from getLaxDir() at import, so the env
// override must be in place BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-sweep-cost-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { sweepStaleCanonicalOpsCooperatively } = await import("./recovery-sweep.js");
const { listActiveCanonicalOps } = await import("./active-ops.js");
const { opsWhere, openOpIds } = await import("../ops/op-index.js");
const { writeOp, readOp } = await import("../ops/op-store.js");

function mkOp(id: string, state: "succeeded" | "running", sessionId: string): Op {
  return {
    id, type: "freeform", task: "t", contextPack: {} as Op["contextPack"],
    lane: "interactive" as Op["lane"], retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "u", visibility: "private" as Op["visibility"],
    status: (state === "succeeded" ? "completed" : "running") as Op["status"],
    createdAt: new Date().toISOString(), attemptCount: 0, sessionId,
    canonical: {
      flagValue: true, state, sessionId,
      // A live worker holds it: the sweep has nothing to recover, only to look.
      leaseOwner: state === "running" ? "w-1" : null,
      leaseExpiresAt: state === "running" ? new Date(Date.now() + 60_000).toISOString() : null,
    } as unknown as Op["canonical"],
  };
}

const FINISHED = 300;
for (let i = 0; i < FINISHED; i++) writeOp(mkOp(`op_done_${i}`, "succeeded", i % 2 ? "chat-a" : "chat-b"));
writeOp(mkOp("op_live_1", "running", "chat-a"));
writeOp(mkOp("op_live_2", "running", "chat-b"));

describe("a pass over a store of mostly finished ops", () => {
  it("the recovery sweep reads the ops in flight, not every op ever run", async () => {
    const read: string[] = [];
    const readCandidate = (id: string) => { read.push(id); return readOp(id); };
    await sweepStaleCanonicalOpsCooperatively({ readCandidate }); // first pass: the index fills
    read.length = 0;
    const recovered = await sweepStaleCanonicalOpsCooperatively({ readCandidate });
    expect(recovered).toEqual([]);
    expect(read.sort()).toEqual(["op_live_1", "op_live_2"]);
  });

  it("the questions other callers ask come back with the same few ops", () => {
    expect(openOpIds().sort()).toEqual(["op_live_1", "op_live_2"]);
    expect(listActiveCanonicalOps().map((o) => o.opId).sort()).toEqual(["op_live_1", "op_live_2"]);
    expect(opsWhere((f) => f.sessionId === "chat-a")).toHaveLength(FINISHED / 2 + 1);
  });

  it("an op that finishes drops out, and a new one is seen, on the next pass", () => {
    writeOp({ ...mkOp("op_live_1", "succeeded", "chat-a") });
    writeOp(mkOp("op_live_3", "running", "chat-a"));
    expect(openOpIds().sort()).toEqual(["op_live_2", "op_live_3"]);
  });
});
