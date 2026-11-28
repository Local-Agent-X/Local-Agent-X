// operation.json has one writer, so a record at rest that does not parse was
// lost, not caught mid-write. It is moved aside and reported once, instead of
// being read and reported again by every start and every scan of the store (a
// record of 12,369 zero bytes from 2026-11-18: 49 warnings in one server log).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "lax-op-record-"));
const prev = process.env.LAX_DATA_DIR;
process.env.LAX_DATA_DIR = dataDir;
const { readOp, writeOp, OPS_BASE } = await import("./op-store.js");
const { operationRecordPath, readOperationRecord, writeOperationRecord } = await import("./operation-record-file.js");

afterAll(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

let said: string[];
beforeEach(() => {
  said = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { said.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); });

let n = 0;
/** An op folder holding `bytes` as its record, last written `ageSeconds` ago. */
function folderWith(bytes: string | Buffer, ageSeconds: number): { id: string; folder: string; record: string } {
  const id = `op_record_${++n}`;
  const folder = join(OPS_BASE, id);
  mkdirSync(folder, { recursive: true });
  const record = operationRecordPath(folder);
  writeFileSync(record, bytes);
  const at = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(record, at, at);
  return { id, folder, record };
}
const asides = (folder: string) => readdirSync(folder).filter((name) => name.startsWith("operation.json.unreadable-"));
const AN_HOUR = 3600;

describe("a record that can never be read", () => {
  it("is moved aside whole and said once: all zero bytes, the write the disk never received", () => {
    const lost = Buffer.alloc(12_369);
    const { id, folder, record } = folderWith(lost, AN_HOUR);

    expect(readOp(id)).toBeNull();

    expect(existsSync(record)).toBe(false);
    const [aside] = asides(folder);
    expect(asides(folder)).toHaveLength(1);
    expect(readFileSync(join(folder, aside)).equals(lost)).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(id);
    expect(said[0]).toContain("all 12369 of its bytes are zero");
    expect(said[0]).toContain(aside);

    // Every later read finds a folder with no record, and says nothing.
    expect(readOp(id)).toBeNull();
    expect(readOp(id)).toBeNull();
    expect(said).toHaveLength(1);
    expect(asides(folder)).toEqual([aside]);
  });

  it("is moved aside when it is cut short, with what the parser said", () => {
    const { id, folder, record } = folderWith('{"id":"op_x","task":"hal', AN_HOUR);
    expect(readOperationRecord(folder, id)).toBeUndefined();
    expect(existsSync(record)).toBe(false);
    expect(asides(folder)).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/JSON/);
  });
});

describe("a record that may yet be read is left where it is", () => {
  it("one that does not parse but was written a moment ago", () => {
    const { id, folder, record } = folderWith("", 1);
    expect(readOperationRecord(folder, id)).toBeUndefined();
    expect(existsSync(record)).toBe(true);
    expect(asides(folder)).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`failed to read op ${id}`);
  });

  it("one that parses but is not an Op: autopilot's record, or a newer build's", () => {
    const autopilot = JSON.stringify({ kind: "autopilot", id: "op_ap_1", goal: "tidy" });
    const { id, folder, record } = folderWith(autopilot, AN_HOUR);
    expect(readOp(id)).toBeNull();
    expect(readFileSync(record, "utf-8")).toBe(autopilot);
    expect(asides(folder)).toEqual([]);
    expect(said).toEqual([]);
  });

  it("a folder with no record says nothing", () => {
    const folder = join(OPS_BASE, "op_record_none");
    mkdirSync(folder, { recursive: true });
    expect(readOperationRecord(folder, "op_record_none")).toBeUndefined();
    expect(readOp("op_record_never_existed")).toBeNull();
    expect(said).toEqual([]);
  });
});

describe("writing a record", () => {
  it("replaces the old one whole and leaves nothing beside it", () => {
    const { folder, record } = folderWith('{"old":true}', AN_HOUR);
    writeOperationRecord(folder, '{"new":true}');
    expect(readFileSync(record, "utf-8")).toBe('{"new":true}');
    expect(readdirSync(folder)).toEqual(["operation.json"]);
  });

  it("an Op written and read back is the same Op, and its record is fresh", () => {
    const op = {
      id: "op_record_roundtrip", type: "freeform", task: "round trip", contextPack: {}, lane: "interactive",
      retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [] }, ownerId: "u", visibility: "private",
      status: "pending", createdAt: new Date().toISOString(), attemptCount: 0,
    } as unknown as Parameters<typeof writeOp>[0];
    writeOp(op);
    expect(readOp(op.id)?.task).toBe("round trip");
    expect(Date.now() - statSync(operationRecordPath(join(OPS_BASE, op.id))).mtimeMs).toBeLessThan(60_000);
  });
});

// "Does not parse" can only mean "lost" while nothing writes the file in place.
// A file that names operation.json in its code and also writes files is either
// this module or a second writer.
describe("operation.json has one writer", () => {
  const src = join(__dirname, "..");
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const WRITES = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|atomicWriteFileSync)\s*\(/;

  it("no other source file both names the file and writes files", () => {
    const writers = sources(src)
      .filter((path) => {
        const text = code(readFileSync(path, "utf-8"));
        return text.includes('"operation.json"') && WRITES.test(text);
      })
      .map((path) => relative(src, path).replace(/\\/g, "/"));
    expect(writers).toEqual([
      // Reads each record for its dates; what it writes is the session log.
      "memory/session-time-backfill.ts",
      "ops/operation-record-file.ts",
    ]);
  });
});
