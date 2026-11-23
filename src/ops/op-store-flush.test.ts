// An op record is flushed to disk before it is renamed into place. Without the
// flush, a crash could leave operation.json as all zero bytes: the record was
// renamed in, its data never reached the disk (12,369 NULs on the owner's
// machine, 2026-11-18, logged as unreadable thousands of times after).
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ calls: [] as string[], fdPaths: new Map<number, string>() }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  const isRecord = (p: unknown) => typeof p === "string" && p.includes("operation.json");
  return {
    ...actual,
    openSync: ((p: unknown, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
      if (isRecord(p)) h.fdPaths.set(fd, String(p));
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      if (h.fdPaths.has(fd)) h.calls.push("fsync");
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    renameSync: ((from: unknown, to: unknown) => {
      if (isRecord(to)) h.calls.push("rename");
      return actual.renameSync(from as string, to as string);
    }) as typeof actual.renameSync,
  };
});

const dataDir = mkdtempSync(join(tmpdir(), "lax-op-flush-"));
const prev = process.env.LAX_DATA_DIR;
process.env.LAX_DATA_DIR = dataDir;
const { writeOp, writeOpStrict, readOp, OPS_BASE } = await import("./op-store.js");

afterAll(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

function op(id: string) {
  return {
    id, type: "freeform", task: "flush", contextPack: {}, lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] }, ownerId: "u", visibility: "private",
    status: "pending", createdAt: new Date().toISOString(), attemptCount: 0,
  } as unknown as Parameters<typeof writeOp>[0];
}

describe("an op record reaches the disk before it replaces the old one", () => {
  it("writeOp and writeOpStrict flush the new record, then rename it in", () => {
    h.calls.length = 0;
    writeOp(op("op_flush_plain"));
    expect(h.calls).toEqual(["fsync", "rename"]);

    h.calls.length = 0;
    expect(writeOpStrict(op("op_flush_strict"))).toBe(true);
    expect(h.calls).toEqual(["fsync", "rename"]);
  });

  it("the record reads back whole", () => {
    writeOp(op("op_flush_read"));
    expect(readOp("op_flush_read")?.task).toBe("flush");
    const raw = readFileSync(join(OPS_BASE, "op_flush_read", "operation.json"), "utf-8");
    expect(JSON.parse(raw).id).toBe("op_flush_read");
  });
});
