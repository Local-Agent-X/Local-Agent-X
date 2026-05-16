import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeOp, readOp, setOpStatus, newOpId, listOps } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

let counter = 0;
const opId = (label: string) => `optest_${Date.now().toString(36)}_${++counter}_${label}`;

const mkOp = (id: string, over: Partial<Op> = {}): Op => ({
  id,
  type: over.type ?? "freeform",
  task: over.task ?? "do the thing",
  contextPack: over.contextPack ?? ({} as Op["contextPack"]),
  lane: over.lane ?? "build",
  retryPolicy: over.retryPolicy ?? { maxRecoveryAttempts: 3, backoffMs: [5_000] },
  ownerId: over.ownerId ?? "u",
  visibility: over.visibility ?? "private",
  status: over.status ?? "pending",
  createdAt: over.createdAt ?? new Date().toISOString(),
  attemptCount: over.attemptCount ?? 0,
  ...over,
});

const OPS_BASE = join(homedir(), ".lax", "operations");
const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  createdIds.length = 0;
});

function track(id: string): string {
  createdIds.push(id);
  return id;
}

describe("newOpId", () => {
  it("uses default 'op' prefix when none given", () => {
    const id = newOpId();
    expect(id.startsWith("op_")).toBe(true);
  });

  it("uses a custom prefix when provided", () => {
    const id = newOpId("research");
    expect(id.startsWith("research_")).toBe(true);
  });

  it("generates collision-resistant ids across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(newOpId("x"));
    expect(ids.size).toBe(50);
  });

  it("ids contain a date36 segment + random suffix", () => {
    const id = newOpId("op");
    const parts = id.split("_");
    expect(parts).toHaveLength(3);
    expect(parts[2].length).toBeGreaterThanOrEqual(4);
  });
});

describe("writeOp + readOp round-trip", () => {
  it("returns null for an opId that was never written", () => {
    expect(readOp(track(opId("missing")))).toBeNull();
  });

  it("round-trips a freshly created op", () => {
    const id = track(opId("rt"));
    const op = mkOp(id, { task: "ship the feature", lane: "interactive" });
    writeOp(op);
    const got = readOp(id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(id);
    expect(got!.task).toBe("ship the feature");
    expect(got!.lane).toBe("interactive");
  });

  it("overwrites previous content on second write (atomic replace)", () => {
    const id = track(opId("ovr"));
    writeOp(mkOp(id, { task: "first" }));
    writeOp(mkOp(id, { task: "second", attemptCount: 5 }));
    const got = readOp(id);
    expect(got!.task).toBe("second");
    expect(got!.attemptCount).toBe(5);
  });

  it("persists nested retryPolicy correctly", () => {
    const id = track(opId("rp"));
    writeOp(mkOp(id, { retryPolicy: { maxRecoveryAttempts: 7, backoffMs: [1, 2, 3] } }));
    const got = readOp(id);
    expect(got!.retryPolicy.maxRecoveryAttempts).toBe(7);
    expect(got!.retryPolicy.backoffMs).toEqual([1, 2, 3]);
  });

  it("returns null for malformed JSON on disk rather than throwing", () => {
    const id = track(opId("malformed"));
    const dir = join(OPS_BASE, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "operation.json"), "{ broken", "utf-8");
    expect(readOp(id)).toBeNull();
  });

  it("writes operation.json under the op dir, not the tmp file", () => {
    const id = track(opId("tmp"));
    writeOp(mkOp(id));
    const dir = join(OPS_BASE, id);
    expect(existsSync(join(dir, "operation.json"))).toBe(true);
    expect(existsSync(join(dir, "operation.json.tmp"))).toBe(false);
  });
});

describe("setOpStatus", () => {
  it("returns null when the op doesn't exist", () => {
    expect(setOpStatus(track(opId("nope")), "completed")).toBeNull();
  });

  it("updates status and persists the change", () => {
    const id = track(opId("upd"));
    writeOp(mkOp(id, { status: "pending" }));
    const updated = setOpStatus(id, "running");
    expect(updated!.status).toBe("running");
    expect(readOp(id)!.status).toBe("running");
  });

  it("auto-stamps startedAt when transitioning to running and not previously set", () => {
    const id = track(opId("started"));
    writeOp(mkOp(id, { status: "pending" }));
    const before = Date.now();
    const updated = setOpStatus(id, "running");
    const stamped = Date.parse(updated!.startedAt!);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });

  it("preserves existing startedAt instead of overwriting", () => {
    const id = track(opId("preserve-start"));
    const original = new Date("2026-01-01T00:00:00Z").toISOString();
    writeOp(mkOp(id, { status: "running", startedAt: original }));
    const updated = setOpStatus(id, "running");
    expect(updated!.startedAt).toBe(original);
  });

  it("auto-stamps completedAt when transitioning to completed", () => {
    const id = track(opId("done"));
    writeOp(mkOp(id, { status: "running" }));
    const updated = setOpStatus(id, "completed");
    expect(updated!.completedAt).toBeDefined();
  });

  it("auto-stamps completedAt when transitioning to failed", () => {
    const id = track(opId("fail"));
    writeOp(mkOp(id, { status: "running" }));
    const updated = setOpStatus(id, "failed", { lastFailureReason: "timeout" });
    expect(updated!.completedAt).toBeDefined();
    expect(updated!.lastFailureReason).toBe("timeout");
  });

  it("auto-stamps completedAt when transitioning to cancelled", () => {
    const id = track(opId("cancel"));
    writeOp(mkOp(id, { status: "running" }));
    expect(setOpStatus(id, "cancelled")!.completedAt).toBeDefined();
  });

  it("merges extras into the persisted op", () => {
    const id = track(opId("extras"));
    writeOp(mkOp(id, { status: "pending" }));
    const updated = setOpStatus(id, "running", { workerId: "worker-A", attemptCount: 2 });
    expect(updated!.workerId).toBe("worker-A");
    expect(updated!.attemptCount).toBe(2);
    expect(readOp(id)!.workerId).toBe("worker-A");
  });

  it("does not stamp startedAt for non-running transitions", () => {
    const id = track(opId("no-start"));
    writeOp(mkOp(id, { status: "pending" }));
    const updated = setOpStatus(id, "cancelled");
    expect(updated!.startedAt).toBeUndefined();
  });
});

describe("listOps", () => {
  it("returns ops we just wrote, newest first by startedAt|createdAt", () => {
    const oldId = track(opId("old"));
    const newId = track(opId("new"));
    writeOp(mkOp(oldId, { createdAt: new Date("2026-01-01T00:00:00Z").toISOString() }));
    writeOp(mkOp(newId, { createdAt: new Date("2026-05-01T00:00:00Z").toISOString() }));
    const all = listOps();
    const idx = (id: string) => all.findIndex(o => o.id === id);
    expect(idx(newId)).toBeGreaterThanOrEqual(0);
    expect(idx(oldId)).toBeGreaterThanOrEqual(0);
    expect(idx(newId)).toBeLessThan(idx(oldId));
  });

  it("does not crash when an op on disk persisted createdAt as a number (epoch-ms)", () => {
    // Real-world: autopilot writers persist createdAt as a number (op_ap_*).
    // The comparator must coerce to String before localeCompare.
    const numericId = track(opId("numeric"));
    const dir = join(OPS_BASE, numericId);
    mkdirSync(dir, { recursive: true });
    const raw = { ...mkOp(numericId), createdAt: Date.now() as unknown as string };
    writeFileSync(join(dir, "operation.json"), JSON.stringify(raw), "utf-8");
    expect(() => listOps()).not.toThrow();
  });
});
