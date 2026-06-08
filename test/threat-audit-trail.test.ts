import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CryptoAuditTrail, getSharedAuditTrail } from "../src/threat/audit-trail.js";

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

  it("verifies a GENUINE pre-anchoring log (legacy-only, no marker, no anchor) with anchorChecked: false", () => {
    // The genuine back-compat case the anchor cross-check may still skip: an
    // old dev file with NO hmac-v1 rows, NO era marker, and NO anchor file.
    // (A chain written by record() is hmac-v1 and lays down the marker, so its
    // missing anchor now fails CLOSED — see the C2 regression test below.)
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
    new CryptoAuditTrail(dataDir); // make the audit dir; does not write a marker
    writeFileSync(path, JSON.stringify(legacy) + "\n");
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

describe("getSharedAuditTrail — single-writer integrity (H10)", () => {
  it("returns the SAME instance for repeated calls on the same dataDir", () => {
    const a = getSharedAuditTrail(dataDir);
    const b = getSharedAuditTrail(dataDir);
    expect(a).toBe(b);
  });

  it("two writers for the same dataDir interleaved keep the chain valid", () => {
    // Both writers resolve to the SAME shared instance, so interleaved record()
    // calls stay on one serialized chain head. Pre-fix, two separate `new`
    // instances at the same head wrote conflicting prevHash/seq and broke verify.
    const w1 = getSharedAuditTrail(dataDir);
    const w2 = getSharedAuditTrail(dataDir);
    expect(w1).toBe(w2);
    w1.record({ sessionId: "s", event: "x", decision: "allow", reason: "w1-a" });
    w2.record({ sessionId: "s", event: "x", decision: "block", reason: "w2-a" });
    w1.record({ sessionId: "s", event: "x", decision: "allow", reason: "w1-b" });
    w2.record({ sessionId: "s", event: "x", decision: "warn", reason: "w2-b" });
    const r = CryptoAuditTrail.verify(dailyAuditPath());
    expect(r.valid).toBe(true);
    expect(r.total).toBe(4);
  });

  it("proves the test has teeth: two SEPARATE `new` instances interleaved DESYNC", () => {
    // The bug being fixed: independent instances against the same daily file each
    // track their own head, so interleaved appends collide and verify() fails.
    const a = new CryptoAuditTrail(dataDir);
    const b = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "a1" });
    b.record({ sessionId: "s", event: "x", decision: "allow", reason: "b1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "a2" });
    expect(CryptoAuditTrail.verify(dailyAuditPath()).valid).toBe(false);
  });
});

describe("CryptoAuditTrail.verify — fail CLOSED against filesystem-only forgery", () => {
  // Reconstruct the legacy (pre-upgrade) hash exactly as the old writer did:
  // plain SHA-256 over the narrow field set, no key required. This is what a
  // filesystem-only attacker (no HMAC key) can compute.
  function legacyHash(e: Record<string, unknown>): string {
    const payload = JSON.stringify({
      seq: e.seq, timestamp: e.timestamp, sessionId: e.sessionId,
      event: e.event, toolName: e.toolName, decision: e.decision,
      reason: e.reason, prevHash: e.prevHash,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  it("C1: once hmac-v1 era is active, a self-consistent legacy (no-hashScheme, plain-SHA-256) rewrite FAILS", () => {
    // Write a real hmac-v1 chain so the sealed era marker is laid down.
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "incriminating", threatScore: 99 });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "also bad", threatScore: 88 });
    const path = dailyAuditPath();

    // Attacker (no key) deletes the anchor file and rewrites the main log as a
    // fully self-consistent plain-SHA-256 chain that OMITS hashScheme, pointing
    // verify() at the unkeyed legacy branch. Pre-fix this returned valid:true.
    rmSync(path.replace(/\.jsonl$/, ".anchors.jsonl"), { force: true });
    let prev = "GENESIS";
    const forged: string[] = [];
    for (let i = 0; i < 2; i++) {
      const e: Record<string, unknown> = {
        seq: i, timestamp: new Date().toISOString(), sessionId: "s",
        event: "x", decision: "allow", reason: "innocuous", prevHash: prev,
      };
      e.hash = legacyHash(e);
      prev = e.hash as string;
      forged.push(JSON.stringify(e));
    }
    writeFileSync(path, forged.join("\n") + "\n");

    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
  });

  it("C1b: the marker alone (era active) rejects legacy rows even with no hmac-v1 rows left on disk", () => {
    // Lay down the marker via a real hmac-v1 write, then replace the file with
    // a legacy-only chain. The marker file remains → era stays active → the
    // unkeyed legacy path is off-limits even though no hmac-v1 row survives.
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "real", threatScore: 50 });
    const path = dailyAuditPath();
    rmSync(path.replace(/\.jsonl$/, ".anchors.jsonl"), { force: true });
    const legacy: Record<string, unknown> = {
      seq: 0, timestamp: new Date().toISOString(), sessionId: "s",
      event: "x", decision: "allow", reason: "innocuous", prevHash: "GENESIS",
    };
    legacy.hash = legacyHash(legacy);
    writeFileSync(path, JSON.stringify(legacy) + "\n");
    expect(CryptoAuditTrail.verify(path).valid).toBe(false);
  });

  it("C2: deleting the anchor file and dropping the last main-chain line FAILS (no fail-open)", () => {
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "2" });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "3-incriminating" });
    const path = dailyAuditPath();

    // Attacker deletes the anchor (which would pin count=3) and drops the last
    // main-chain line. The 2-line prefix is a valid hmac-v1 chain on its own;
    // pre-fix verify() returned valid:true / anchorChecked:false. Now the
    // missing anchor with hmac-v1 data present is treated as truncation.
    rmSync(path.replace(/\.jsonl$/, ".anchors.jsonl"), { force: true });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");

    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.anchorChecked).toBe(true);
  });
});
