import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  // CryptoAuditTrail writes to <dataDir>/audit/<YYYY-MM-DD>.jsonl plus a
  // sibling <YYYY-MM-DD>.anchors.jsonl (external anchor chain) — exclude the
  // latter so this resolves the main log only.
  const auditDir = join(dataDir, "audit");
  const files = readdirSync(auditDir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
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

describe("CryptoAuditTrail — HMAC keyed chain + full-field coverage", () => {
  it("a fresh chain written under the new code verifies as valid (hmac-v1)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({
      sessionId: "s", event: "tool_executed", decision: "block", reason: "scored high",
      role: "operator", threatScore: 92, threatLevel: "high", dataLabels: ["secret"],
    });
    a.record({ sessionId: "s", event: "tick", decision: "allow", reason: "ok" });
    const path = dailyAuditPath();
    const first = JSON.parse(readFileSync(path, "utf-8").trim().split("\n")[0]);
    expect(first.hashScheme).toBe("hmac-v1");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(true);
    expect(r.total).toBe(2);
  });

  it("tampering with threatScore (previously NOT hashed) now FAILS verification", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "r", threatScore: 90, role: "operator" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "r2" });
    const path = dailyAuditPath();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.threatScore = 1; // downgrade severity without touching reason/decision
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, lines.join("\n") + "\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
  });

  it("tampering with dataLabels or role now FAILS verification", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "r", role: "operator", dataLabels: ["secret"] });
    const path = dailyAuditPath();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const t1 = JSON.parse(lines[0]);
    t1.role = "readonly";
    writeFileSync(path, JSON.stringify(t1) + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(false);

    const t2 = JSON.parse(lines[0]);
    t2.dataLabels = [];
    writeFileSync(path, JSON.stringify(t2) + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(false);
  });

  it("a plain SHA-256 forgery (no HMAC key) does NOT produce a valid chain", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "r", threatScore: 5 });
    const path = dailyAuditPath();
    const entry = JSON.parse(readFileSync(path, "utf-8").trim().split("\n")[0]);
    // Attacker rewrites the row and recomputes the hash with plain SHA-256
    // (they don't have the key). Keep hashScheme so it goes through the keyed
    // verify path — the forged hash will not match the HMAC.
    entry.threatScore = 999;
    const forgedPayload = JSON.stringify(entry);
    entry.hash = createHash("sha256").update(forgedPayload).digest("hex");
    writeFileSync(path, JSON.stringify(entry) + "\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
  });

  it("a non-genesis NULL/empty previousHash anchor is rejected (truncation/re-root)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    const path = dailyAuditPath();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    const second = JSON.parse(lines[1]);
    second.prevHash = ""; // empty anchor mid-chain = re-rooted
    lines[1] = JSON.stringify(second);
    writeFileSync(path, lines.join("\n") + "\n");
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(1);

    // A second GENESIS anchor mid-chain is likewise rejected.
    const lines2 = readFileSync(path, "utf-8").trim().split("\n");
    const reanchor = JSON.parse(lines2[1]);
    reanchor.prevHash = "GENESIS";
    lines2[1] = JSON.stringify(reanchor);
    writeFileSync(path, lines2.join("\n") + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(false);
  });

  it("a fresh chain reports anchorChecked: true (anchor file present)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    const r = CryptoAuditTrail.verify(dailyAuditPath());
    expect(r.valid).toBe(true);
    expect(r.anchorChecked).toBe(true);
  });

  it("detects TAIL-TRUNCATION that the linear chain alone cannot", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "3" });
    const path = dailyAuditPath();

    // Drop the last entry. The remaining 2-line file is a VALID chain prefix —
    // the linear hash-chain has no way to know a third entry ever existed.
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");

    // The anchor file still records 3 heads → the truncation is caught.
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.anchorChecked).toBe(true);
  });

  it("detects a forged anchor head (anchor/chain divergence)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    const path = dailyAuditPath();
    const anchorPath = path.replace(/\.jsonl$/, ".anchors.jsonl");
    const alines = readFileSync(anchorPath, "utf-8").trim().split("\n");
    const tampered = JSON.parse(alines[0]);
    tampered.chainHash = "f".repeat(64); // rewrite the pinned head, no key to re-MAC
    alines[0] = JSON.stringify(tampered);
    writeFileSync(anchorPath, alines.join("\n") + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(false);
  });

  it("verifies a pre-anchoring log (no anchor file) with anchorChecked: false", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    const path = dailyAuditPath();
    rmSync(path.replace(/\.jsonl$/, ".anchors.jsonl"), { force: true });
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(true);
    expect(r.anchorChecked).toBe(false);
  });

  it("legacy plain-SHA-256 entries (no hashScheme tag) still verify — boot compat", () => {
    // Simulate a pre-upgrade audit file written under the old narrow scheme.
    const legacy = {
      seq: 0, timestamp: new Date().toISOString(), sessionId: "s", event: "x",
      decision: "allow", reason: "legacy", prevHash: "GENESIS",
    } as Record<string, unknown>;
    const payload = JSON.stringify({
      seq: legacy.seq, timestamp: legacy.timestamp, sessionId: legacy.sessionId,
      event: legacy.event, toolName: undefined, decision: legacy.decision,
      reason: legacy.reason, prevHash: legacy.prevHash,
    });
    legacy.hash = createHash("sha256").update(payload).digest("hex");
    const auditDir = join(dataDir, "audit");
    const date = new Date().toISOString().slice(0, 10);
    const path = join(auditDir, `${date}.jsonl`);
    // Ensure the audit dir exists by constructing a trail first.
    new CryptoAuditTrail(dataDir);
    writeFileSync(path, JSON.stringify(legacy) + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(true);
  });
});
