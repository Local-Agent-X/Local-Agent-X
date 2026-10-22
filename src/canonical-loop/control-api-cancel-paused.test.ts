/**
 * Cancelling a paused op. Cancels are acted on inside a running turn, and a paused op
 * has no worker, so a cancel on one was only recorded: three suspended Dream runs
 * cancelled from the phone on 2026-10-22 stayed paused, and Cancel looked dead. A
 * paused op now goes straight to cancelled, like a queued op no worker has leased.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-cancel-paused-"));
process.env.LAX_DATA_DIR = dataDir;
const [{ opCancel }, { readCanonicalEvents }, { readOp, writeOp }] = await Promise.all([
  import("./control-api.js"), import("./store.js"), import("../ops/op-store.js"),
]);

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function pausedOp(id: string, extra: Record<string, unknown> = {}): void {
  writeOp({
    id, type: "memory_consolidation", task: "dream", lane: "background",
    retryPolicy: {}, ownerId: "local-user", visibility: "private", status: "paused",
    createdAt: new Date().toISOString(), attemptCount: 0,
    canonical: { state: "paused", suspension: { reason: "blocked", detail: "x", suspendedAt: "" }, ...extra },
  } as never);
}

describe("opCancel on a paused op", () => {
  it("cancels it at once, with the transition on record", () => {
    pausedOp("op-paused-1");
    expect(opCancel("op-paused-1", "user-stop").ok).toBe(true);
    const op = readOp("op-paused-1")!;
    expect(op.canonical?.state).toBe("cancelled");
    expect(op.canonical?.cancelRequestedAt ?? null).toBeNull();
    expect(readCanonicalEvents("op-paused-1").some((e) => e.type === "state_changed" && (e.body as { to?: string }).to === "cancelled")).toBe(true);
  });

  it("finishes a cancel that was requested before and left waiting", () => {
    pausedOp("op-paused-2", { cancelRequestedAt: "2026-10-22T17:04:00.740Z" });
    expect(opCancel("op-paused-2", "user-stop").ok).toBe(true);
    expect(readOp("op-paused-2")!.canonical?.state).toBe("cancelled");
  });

  it("a second cancel of the cancelled op says it is already over", () => {
    pausedOp("op-paused-3");
    opCancel("op-paused-3", "user-stop");
    expect(opCancel("op-paused-3", "user-stop")).toMatchObject({ ok: false, code: "terminal" });
  });
});
