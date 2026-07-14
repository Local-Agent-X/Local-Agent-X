/**
 * Active-op listing (listActiveCanonicalOps) — pendingApproval / sessionId
 * pass-through for the approval-rediscovery surface, plus the existing
 * active-state filter it must not perturb.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

// op-store binds its base dir from getLaxDir() at import, so the env
// override must be in place BEFORE the dynamic imports below.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-active-ops-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { listActiveCanonicalOps } = await import("./active-ops.js");
const { writeOp } = await import("../ops/op-store.js");

const mkOp = (id: string, canonical: Op["canonical"]): Op => ({
  id,
  type: "freeform",
  task: "do the thing",
  contextPack: {} as Op["contextPack"],
  lane: "interactive" as Op["lane"],
  retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: "u",
  visibility: "private" as Op["visibility"],
  status: "running" as Op["status"],
  createdAt: new Date().toISOString(),
  attemptCount: 0,
  canonical,
});

describe("listActiveCanonicalOps — approval column pass-through", () => {
  it("surfaces pendingApproval and sessionId; null when absent", () => {
    const record = {
      approvalId: "apr-1",
      toolName: "bash",
      argsPreview: `{"command":"rm -rf build"}`,
      context: "irreversible",
      requestedAt: Date.now(),
    };
    writeOp(mkOp("op_blocked", {
      state: "running", flagValue: true, sessionId: "sess-9", pendingApproval: record,
    }));
    writeOp(mkOp("op_plain", { state: "running", flagValue: true }));
    writeOp(mkOp("op_done", {
      state: "succeeded", flagValue: true, pendingApproval: record,
    }));

    const rows = listActiveCanonicalOps();
    const blocked = rows.find(r => r.opId === "op_blocked");
    expect(blocked?.pendingApproval).toEqual(record);
    expect(blocked?.sessionId).toBe("sess-9");

    const plain = rows.find(r => r.opId === "op_plain");
    expect(plain?.pendingApproval).toBeNull();
    expect(plain?.sessionId).toBeNull();

    // Terminal op stays excluded regardless of its column.
    expect(rows.find(r => r.opId === "op_done")).toBeUndefined();
  });
});
