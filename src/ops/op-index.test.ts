// The op index answers questions about the store without reading all of it:
// a record is read when it is new or changed, a settled one never again, and
// the first pass can be spread across the event loop.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BULK_READ, createOpScanner, opFactsOf, type BulkRead } from "./op-index.js";
import type { Op, OpStatus } from "./types.js";

let dir: string;
let reads: string[];

function record(id: string, status: OpStatus, extra: Partial<Op> = {}): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "operation.json"), JSON.stringify({ id, type: "freeform", status, createdAt: "2026-01-01T00:00:00.000Z", ...extra }));
}
/** A later mtime, as a rewrite gives a record: same-millisecond writes happen in tests, not in use. */
function touch(id: string, secondsAhead: number): void {
  const at = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(join(dir, id, "operation.json"), at, at);
}
function read(id: string): Op | null {
  reads.push(id);
  try { return JSON.parse(readFileSync(join(dir, id, "operation.json"), "utf-8")) as Op; } catch { return null; }
}
const scanner = () => createOpScanner(dir, read, opFactsOf, (op) => !opFactsOf(op).open);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-op-index-")); reads = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createOpScanner", () => {
  it("reads each record once, then only the ones that changed", () => {
    record("op_done", "completed", { sessionId: "chat-a" });
    record("op_live", "running", { sessionId: "chat-a" });
    const s = scanner();
    expect([...s.refresh().keys()].sort()).toEqual(["op_done", "op_live"]);
    expect(reads.sort()).toEqual(["op_done", "op_live"]);

    reads = [];
    s.refresh();
    expect(reads).toEqual([]); // nothing changed: nothing read

    record("op_live", "completed", { sessionId: "chat-a" });
    touch("op_live", 5);
    expect(s.refresh().get("op_live")).toMatchObject({ status: "completed", open: false });
    expect(reads).toEqual(["op_live"]);
  });

  it("never looks at a settled op again, even if its file is touched", () => {
    record("op_done", "completed");
    const s = scanner();
    s.refresh();
    reads = [];
    touch("op_done", 5);
    s.refresh();
    expect(reads).toEqual([]);
  });

  it("an op whose canonical run is still going is not settled by its status alone", () => {
    record("op_half", "completed", { canonical: { state: "running" } as Op["canonical"] });
    const s = scanner();
    expect(s.refresh().get("op_half")?.open).toBe(true);
    reads = [];
    touch("op_half", 5);
    s.refresh();
    expect(reads).toEqual(["op_half"]);
  });

  it("an unreadable record is left out and not read again until it changes", () => {
    mkdirSync(join(dir, "op_bad"));
    writeFileSync(join(dir, "op_bad", "operation.json"), "          ");
    const s = scanner();
    expect(s.refresh().has("op_bad")).toBe(false);
    reads = [];
    s.refresh();
    expect(reads).toEqual([]);
    record("op_bad", "running");
    touch("op_bad", 5);
    expect(s.refresh().has("op_bad")).toBe(true);
  });

  it("drops an op whose folder is gone, and skips a folder with no record yet", () => {
    record("op_a", "running");
    mkdirSync(join(dir, "op_empty"));
    const s = scanner();
    expect([...s.refresh().keys()]).toEqual(["op_a"]);
    rmSync(join(dir, "op_a"), { recursive: true });
    expect([...s.refresh().keys()]).toEqual([]);
  });

  it("a store with no folder yet is empty, not an error", () => {
    rmSync(dir, { recursive: true });
    expect(scanner().refresh().size).toBe(0);
  });

  it("warm fills the same index in slices, pausing between them", async () => {
    for (let i = 0; i < 120; i++) record(`op_${i}`, "completed", { sessionId: i % 2 ? "chat-a" : "chat-b" });
    const s = scanner();
    let pauses = 0;
    await s.warm(async () => { pauses++; });
    expect(pauses).toBe(2); // 120 ops, 50 a slice
    reads = [];
    expect(s.refresh().size).toBe(120);
    expect(reads).toEqual([]); // the warm pass was the first pass
  });

  it("warms once: a caller that asks while the pass is running waits on that pass", async () => {
    for (let i = 0; i < 120; i++) record(`op_${i}`, "completed");
    const s = scanner();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = s.warm(() => held);
    const second = s.warm();
    expect(second).toBe(first);
    expect(reads).toHaveLength(50); // stopped at the first pause, not finished by the second caller
    release();
    await second;
    expect(reads).toHaveLength(120);
    reads = [];
    await s.warm();
    expect(reads).toEqual([]);
  });

  // A query that pays for the first pass holds the server's thread for it.
  // It is reported, so the caller that should have waited is named in the log.
  describe("a query that reads much of the store itself", () => {
    const reported: BulkRead[] = [];
    const reporting = () => createOpScanner(dir, read, opFactsOf, (op) => !opFactsOf(op).open, (pass) => reported.push(pass));
    beforeEach(() => { reported.length = 0; });

    it("is reported with how many records it read", () => {
      for (let i = 0; i < BULK_READ; i++) record(`op_${i}`, "completed");
      const s = reporting();
      s.refresh();
      expect(reported).toEqual([{ read: BULK_READ, ms: expect.any(Number) }]);
      s.refresh();
      expect(reported).toHaveLength(1); // the next query reads nothing
    });

    it("is not reported once the background pass has read the store", async () => {
      for (let i = 0; i < BULK_READ; i++) record(`op_${i}`, "completed");
      const s = reporting();
      await s.warm();
      s.refresh();
      expect(reported).toEqual([]);
    });

    it("is not reported for the few ops that moved since the last query", () => {
      for (let i = 0; i < BULK_READ - 1; i++) record(`op_${i}`, "running");
      const s = reporting();
      s.refresh();
      for (let i = 0; i < 5; i++) { record(`op_${i}`, "completed"); touch(`op_${i}`, 5); }
      s.refresh();
      expect(reported).toEqual([]);
    });
  });
});

describe("opFactsOf", () => {
  it("keeps what a query asks about: whose it is, what it is, whether it can still move", () => {
    const facts = opFactsOf({
      id: "op_1", type: "app_build", status: "running", sessionId: "chat-a", appUrl: "/apps/x/",
      canonical: { state: "running", sessionId: "agent-1" }, dependsOn: ["op_0"],
    } as unknown as Op);
    expect(facts).toEqual({
      sessionId: "chat-a", canonicalSessionId: "agent-1", type: "app_build", status: "running",
      appUrl: "/apps/x/", open: true, hasDependencies: true,
    });
  });

  it("a finished op with no dependencies is closed", () => {
    expect(opFactsOf({ id: "op_2", type: "freeform", status: "failed" } as unknown as Op))
      .toEqual({ type: "freeform", status: "failed", open: false, hasDependencies: false });
  });
});
