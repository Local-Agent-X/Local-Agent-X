// The audit dir holds three kinds of file: the daily entries, each day's
// anchor chain, and the era marker. The viewer used to list every `.jsonl` as
// a day, so the anchor file read as entries: the search filter threw on a row
// with no `reason`, the counts doubled, and the SIEM export carried anchor rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAuditFiles, parseAuditLines } from "../threat/audit-crypto.js";

let dataDir: string;
let prevDataDir: string | undefined;

const entry = (seq: number, reason: string) =>
  JSON.stringify({ seq, timestamp: new Date(1_700_000_000_000 + seq).toISOString(), sessionId: "s", event: "tool_call", toolName: "bash", decision: "allow", reason, hash: `h${seq}`, prevHash: seq === 0 ? "GENESIS" : `h${seq - 1}` });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-audit-viewer-"));
  const audit = join(dataDir, "audit");
  mkdirSync(audit);
  writeFileSync(join(audit, "2026-10-15.jsonl"), [entry(0, "first"), "{ not a row", entry(1, "second needle")].join("\n") + "\n");
  writeFileSync(join(audit, "2026-10-15.anchors.jsonl"), JSON.stringify({ seq: 1, count: 2, chainHash: "h1", prevAnchor: "ANCHOR-GENESIS", anchorHash: "a" }) + "\n");
  writeFileSync(join(audit, ".hmac-v1.marker"), JSON.stringify({ era: "hmac-v1", mac: "m" }));
  writeFileSync(join(audit, "2026-10-14.jsonl"), entry(0, "yesterday") + "\n");
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("listAuditFiles", () => {
  it("lists the daily entry files newest first, and nothing else in the dir", () => {
    expect(listAuditFiles(join(dataDir, "audit")).map((f) => f.date)).toEqual(["2026-10-15", "2026-10-14"]);
    expect(listAuditFiles(join(dataDir, "nowhere"))).toEqual([]);
  });

  it("a malformed line is skipped, not the day", () => {
    expect(parseAuditLines([entry(0, "a"), "garbage", entry(1, "b")].join("\n")).map((e) => e.reason)).toEqual(["a", "b"]);
  });
});

describe("the viewer reads entries only", () => {
  it("searches, counts and summarizes without reading the anchor file as entries", async () => {
    const { listAuditDates, queryAuditLog, getAuditSummary } = await import("./audit-viewer.js");
    expect(listAuditDates()).toEqual(["2026-10-15", "2026-10-14"]);
    const page = queryAuditLog({ search: "needle" });
    expect(page.total).toBe(1);
    expect(page.entries[0]?.reason).toBe("second needle");
    expect(queryAuditLog({}).total).toBe(3);
    expect(getAuditSummary().totalEntries).toBe(3);
    expect(getAuditSummary("2026-10-15", "2026-10-15").totalEntries).toBe(2);
  });
});
