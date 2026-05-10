import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CryptoAuditTrail } from "../src/threat/audit-trail.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-audit-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function dailyAuditPath(): string {
  // CryptoAuditTrail writes to <dataDir>/audit/<YYYY-MM-DD>.jsonl
  const auditDir = join(dataDir, "audit");
  const files = readdirSync(auditDir).filter(f => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return join(auditDir, files[0]);
}

describe("CryptoAuditTrail — chaining", () => {
  it("first entry has prevHash 'GENESIS' and a non-empty hash", () => {
    const a = new CryptoAuditTrail(dataDir);
    const e = a.record({ sessionId: "s1", event: "tool_executed", decision: "allow", reason: "first" });
    expect(e.prevHash).toBe("GENESIS");
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("second entry's prevHash equals first entry's hash", () => {
    const a = new CryptoAuditTrail(dataDir);
    const e1 = a.record({ sessionId: "s1", event: "tool_executed", decision: "allow", reason: "first" });
    const e2 = a.record({ sessionId: "s1", event: "tool_executed", decision: "allow", reason: "second" });
    expect(e2.prevHash).toBe(e1.hash);
    expect(e2.seq).toBe(e1.seq + 1);
  });
});

describe("CryptoAuditTrail.verify — clean chain", () => {
  it("verifies a freshly-written chain as valid", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "3" });
    const r = CryptoAuditTrail.verify(dailyAuditPath());
    expect(r.valid).toBe(true);
    expect(r.total).toBe(3);
  });

  it("verifies an empty / missing file as valid", () => {
    const r = CryptoAuditTrail.verify(join(dataDir, "does-not-exist.jsonl"));
    expect(r.valid).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe("CryptoAuditTrail.verify — tamper detection", () => {
  it("flags a modified `reason` field at line index", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "before" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "after" });
    const path = dailyAuditPath();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.reason = "TAMPERED";
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, lines.join("\n") + "\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
  });

  it("flags a broken prevHash (chain splice)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    const path = dailyAuditPath();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const second = JSON.parse(lines[1]);
    second.prevHash = "0".repeat(64);
    lines[1] = JSON.stringify(second);
    writeFileSync(path, lines.join("\n") + "\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("flags a malformed JSON line", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    const path = dailyAuditPath();
    writeFileSync(path, "not-json\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
  });
});

describe("CryptoAuditTrail — getRecent", () => {
  it("returns up to N most recent entries", () => {
    const a = new CryptoAuditTrail(dataDir);
    for (let i = 0; i < 30; i++) {
      a.record({ sessionId: "s", event: "tick", decision: "allow", reason: `r${i}` });
    }
    expect(a.getRecent(5)).toHaveLength(5);
    expect(a.getRecent(5)[4].reason).toBe("r29");
  });
});
