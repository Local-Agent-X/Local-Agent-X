import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CryptoAuditTrail, getSharedAuditTrail } from "../src/threat/audit-trail.js";
import { _resetAuditKeyCacheForTests, hasPersistedAuditKey } from "../src/app-runtime/audit-signing.js";

let dataDir: string;
let prevDataDir: string | undefined;
let prevAuditKey: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-audit-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  prevAuditKey = process.env.LAX_AUDIT_KEY;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  if (prevAuditKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevAuditKey;
  _resetAuditKeyCacheForTests();
});

/**
 * Force a genuine NO-KEY environment for the pre-key back-compat cases: point
 * audit-key resolution at the key-less per-test tempdir and unset the env
 * override, then drop the cached seed. The C3 era ratchet keys off
 * hasPersistedAuditKey(), so without this a dev machine's real ~/.lax seed would
 * make the era active and (correctly) reject these legacy chains — but these
 * tests exist to prove the genuine pre-key window still verifies.
 */
function isolateNoKeyEnv(): void {
  process.env.LAX_DATA_DIR = dataDir;
  delete process.env.LAX_AUDIT_KEY;
  _resetAuditKeyCacheForTests();
}

/**
 * Force a genuine KEYED environment: point audit-key resolution at the per-test
 * tempdir and pin an env seed so hasPersistedAuditKey() is true and a stable key
 * is used for both record() and verify() regardless of the dev machine's ~/.lax.
 */
function isolateKeyedEnv(): void {
  process.env.LAX_DATA_DIR = dataDir;
  process.env.LAX_AUDIT_KEY = "test-fixed-audit-seed";
  _resetAuditKeyCacheForTests();
}

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
    // old dev file with NO resolvable seed, NO hmac-v1 rows, NO era marker, and
    // NO anchor file. (A chain written by record() is hmac-v1 and lays down the
    // marker, so its missing anchor now fails CLOSED — see the C2 regression
    // test below.)
    isolateNoKeyEnv();
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
    // Simulate a pre-upgrade audit file written under the old narrow scheme,
    // on a genuine pre-key install (no resolvable seed → era inactive).
    isolateNoKeyEnv();
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

  it("C3-1: with a key resolvable, deleting the marker AND rewriting ALL rows as legacy plain-SHA-256 still FAILS", () => {
    // The residual hole: pre-fix, eraActive keyed only off the marker + row
    // tags, BOTH attacker-deletable. An attacker with FS write deletes the
    // marker + anchor and rewrites the whole log as a self-consistent plain-
    // SHA-256 chain with NO hashScheme tags, flipping block→allow. eraActive
    // went false, the legacy branch recomputed an unkeyed hash over attacker-
    // known bytes, and verify() returned valid:true. Now hasPersistedAuditKey()
    // keeps the era active regardless, so the legacy branch is unreachable.
    isolateKeyedEnv();
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "incriminating", threatScore: 99 });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "also bad", threatScore: 88 });
    const path = dailyAuditPath();

    // Attacker deletes BOTH the sealed era marker AND the anchor, then rewrites
    // every row as a plain-SHA-256 legacy chain (no hashScheme), decision
    // flipped to allow. No hmac-v1 tag and no marker survive — only the key.
    rmSync(join(dataDir, "audit", ".hmac-v1.marker"), { force: true });
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

  it("C3-2: with a key resolvable, deleting the anchor beside a non-empty keyed audit file FAILS as truncation", () => {
    // The anchor cross-check is now bound to key-presence, not just marker/row
    // tags. Even with the marker also deleted, a resolvable seed keeps anchoring
    // "in use", so an ABSENT anchor file alongside a non-empty audit file is
    // truncation evidence rather than a benign checked:false downgrade.
    isolateKeyedEnv();
    const a = new CryptoAuditTrail(dataDir);
    a.record({ sessionId: "s", event: "x", decision: "allow", reason: "1" });
    a.record({ sessionId: "s", event: "x", decision: "block", reason: "2-incriminating" });
    const path = dailyAuditPath();

    // Delete the marker AND the anchor, leaving a valid hmac-v1 chain on disk.
    rmSync(join(dataDir, "audit", ".hmac-v1.marker"), { force: true });
    rmSync(path.replace(/\.jsonl$/, ".anchors.jsonl"), { force: true });

    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.anchorChecked).toBe(true);
  });
});

describe("CryptoAuditTrail — held-handle append path", () => {
  // record() used to re-open BOTH the daily file and the anchor file on every
  // entry (plus stat the era marker). The open, not the write, is what costs —
  // measured over 1500-record bursts on this box, reopen-per-append runs
  // 1265-2101µs/record against 128-176µs through held handles (revalidation
  // included) — so the write path now holds append handles across records. These
  // tests pin the two things that must survive that change: the bytes on disk
  // are unchanged, and every record is still DURABLE before record() returns.

  function rows(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  }
  function anchorPathOf(mainPath: string): string {
    return mainPath.replace(/\.jsonl$/, ".anchors.jsonl");
  }

  it("a burst through the held handle is byte-identical to the reopen-per-record path", () => {
    // Differential oracle: a FRESH CryptoAuditTrail per record resumes the chain
    // from disk and reopens the file for its single append — exactly the
    // reopen-per-append behavior the held handle replaces. Same inputs, same
    // frozen clock, so the chain heads and the on-disk bytes of both files must
    // match exactly. Any divergence (a dropped record, a re-rooted chain, a
    // buffered tail that never landed) fails here.
    isolateKeyedEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const coldDir = mkdtempSync(join(tmpdir(), "lax-audit-cold-"));
    try {
      const inputs = Array.from({ length: 24 }, (_, i) => ({
        sessionId: "s", event: "tool_executed", toolName: "bash",
        decision: (i % 3 === 0 ? "block" : "allow") as "block" | "allow",
        reason: `burst-${i}`, threatScore: i,
      }));

      const held = new CryptoAuditTrail(dataDir);
      const heldHeads = inputs.map(e => held.record(e).hash);
      const reopenHeads = inputs.map(e => new CryptoAuditTrail(coldDir).record(e).hash);
      expect(heldHeads).toEqual(reopenHeads);

      const heldMain = dailyAuditPath();
      const reopenMain = join(coldDir, "audit", "2026-07-28.jsonl");
      expect(readFileSync(heldMain, "utf-8")).toBe(readFileSync(reopenMain, "utf-8"));
      expect(readFileSync(anchorPathOf(heldMain), "utf-8")).toBe(readFileSync(anchorPathOf(reopenMain), "utf-8"));
      expect(CryptoAuditTrail.verify(heldMain).valid).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(coldDir, { recursive: true, force: true });
    }
  });

  it("a 200-record burst stays gapless, monotonic and anchor-aligned", () => {
    const a = new CryptoAuditTrail(dataDir);
    for (let i = 0; i < 200; i++) {
      a.record({ sessionId: "s", event: "tick", decision: "allow", reason: `r${i}` });
    }
    const main = dailyAuditPath();
    const entries = rows(main);
    const anchors = rows(anchorPathOf(main));
    expect(entries).toHaveLength(200);
    expect(anchors).toHaveLength(200);
    for (let i = 0; i < 200; i++) {
      expect(entries[i].seq).toBe(i);
      if (i > 0) expect(entries[i].prevHash).toBe(entries[i - 1].hash);
      expect(anchors[i].seq).toBe(i);
      expect(anchors[i].count).toBe(i + 1);
      expect(anchors[i].chainHash).toBe(entries[i].hash);
    }
    const r = CryptoAuditTrail.verify(main);
    expect(r.valid).toBe(true);
    expect(r.total).toBe(200);
    expect(r.anchorChecked).toBe(true);
  });

  it("each record is on disk in BOTH files before record() returns (no buffered tail)", () => {
    // The invariant that rules a write buffer OUT of this subsystem. A deferred
    // or batched flush drops the chain tail from the main file AND the anchor
    // file together on a crash, and verifyAnchors reconciles those two only
    // against each other — a consistently-shortened pair verifies as a clean
    // chain, so the loss would be SILENT, which is the exact tail-truncation the
    // anchor chain exists to catch. Reading in the same tick with no flush call
    // is what keeps that hole shut.
    const a = new CryptoAuditTrail(dataDir);
    for (let i = 0; i < 5; i++) {
      const written = a.record({ sessionId: "s", event: "tick", decision: "allow", reason: `r${i}` });
      const main = dailyAuditPath();
      const entries = rows(main);
      expect(entries).toHaveLength(i + 1);
      expect(entries[i].hash).toBe(written.hash);
      expect(rows(anchorPathOf(main))).toHaveLength(i + 1);
    }
  });

  it("the daily rollover repoints the held handle at the new day's file", () => {
    // A handle held across midnight would keep appending day 2 into day 1's
    // still-open file, silently splicing two chains into one log. The rollover
    // must drop the handle so the next record reopens against the new date.
    isolateKeyedEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-28T23:59:59.000Z"));
      const a = new CryptoAuditTrail(dataDir);
      a.record({ sessionId: "s", event: "tick", decision: "allow", reason: "day-1" });
      vi.setSystemTime(new Date("2026-07-29T00:00:01.000Z"));
      a.record({ sessionId: "s", event: "tick", decision: "allow", reason: "day-2" });

      const day1 = join(dataDir, "audit", "2026-07-28.jsonl");
      const day2 = join(dataDir, "audit", "2026-07-29.jsonl");
      const d1 = rows(day1);
      const d2 = rows(day2);
      expect(d1).toHaveLength(1);
      expect(d1[0].reason).toBe("day-1");
      expect(d2).toHaveLength(1);
      expect(d2[0].reason).toBe("day-2");
      // The new day restarts at genesis rather than chaining off day 1.
      expect(d2[0].seq).toBe(0);
      expect(d2[0].prevHash).toBe("GENESIS");
      expect(rows(anchorPathOf(day2))).toHaveLength(1);
      expect(CryptoAuditTrail.verify(day1).valid).toBe(true);
      expect(CryptoAuditTrail.verify(day2).valid).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CryptoAuditTrail — held handles must not outlive their files", () => {
  // Both cases below share one root cause: the old open-per-record path was
  // implicitly SELF-HEALING (it recreated a deleted file and re-sealed a deleted
  // era marker on the very next append), and holding the append handle silently
  // dropped that. Neither assertion here passes against the held-handle code
  // without the revalidation tick — that is the whole point of writing them.

  function anchorPathOf(mainPath: string): string {
    return mainPath.replace(/\.jsonl$/, ".anchors.jsonl");
  }

  it("T1: deleting BOTH audit files mid-run is DETECTED, not silently swallowed", () => {
    // The threat model is a filesystem-only attacker, and in a tamper-evident
    // log the party most likely to delete the log is the attacker. Against a
    // held handle with no revalidation, record() keeps writing into the ORPHANED
    // inode: the path never reappears, every subsequent row is unrecoverable,
    // and verify() short-circuits on the missing file to {valid:true, total:0} —
    // a clean bill of health over an erased log.
    isolateKeyedEnv();
    const a = new CryptoAuditTrail(dataDir);
    for (let i = 0; i < 3; i++) {
      a.record({ sessionId: "s", event: "x", decision: "block", reason: `incriminating-${i}` });
    }
    const path = dailyAuditPath();
    rmSync(path, { force: true });
    rmSync(anchorPathOf(path), { force: true });

    // Keep recording. The burst deliberately runs past the revalidation cap: the
    // tick is "every N records OR M ms" and a synchronous burst trips only the
    // record leg, so N records of loss IS the stated exposure window. Detection
    // is bounded, not instant, and the test asserts the bound rather than
    // pretending the window is zero.
    for (let i = 0; i < 24; i++) {
      a.record({ sessionId: "s", event: "x", decision: "block", reason: `after-delete-${i}` });
    }

    // THE security property, asserted first: pre-fix this returned exactly
    // {valid:true, total:0} — a clean bill of health over an erased log.
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(0);
    expect(r.total).toBeGreaterThan(0);

    // The path is live again and the rows written after the tick are on disk —
    // an attacker's erasure no longer runs to the end of the day.
    expect(existsSync(path)).toBe(true);
    const survivors = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    expect(survivors.length).toBeGreaterThan(0);

    // And the recreated file is itself EVIDENCE: seq/prevHash keep running in
    // memory across the reopen, so row 0 of the new file carries a non-GENESIS
    // prevHash — precisely the re-root verify() catches above.
    const first = JSON.parse(survivors[0]) as { prevHash: string; seq: number };
    expect(first.prevHash).not.toBe("GENESIS");
    expect(first.seq).toBeGreaterThan(0);
  });

  it("T3: unlink-and-REPLACE (a valid prefix dropped back at the path) is DETECTED", () => {
    // The competent version of T1, and the reason mere existence is not enough.
    // The attacker reads the log, unlinks both files, and immediately drops a
    // valid PREFIX of each back at the same paths. existsSync() is satisfied, so
    // a presence-only revalidation keeps feeding the orphaned inode and the
    // on-disk pair stays a short, self-consistent, perfectly verifiable chain —
    // every row after the cut erased with no evidence at all. The old
    // open-per-record path caught this for free: it reopened BY PATH, so the
    // next append landed in the replacement and re-rooted it visibly.
    isolateKeyedEnv();
    const a = new CryptoAuditTrail(dataDir);
    for (let i = 0; i < 12; i++) {
      a.record({ sessionId: "s", event: "x", decision: "block", reason: `incriminating-${i}` });
    }
    const path = dailyAuditPath();
    const anchorPath = anchorPathOf(path);
    const keptMain = readFileSync(path, "utf-8").trim().split("\n").slice(0, 3);
    const keptAnchor = readFileSync(anchorPath, "utf-8").trim().split("\n").slice(0, 3);

    // Unlink, then recreate at the same path with the first 3 rows of each.
    rmSync(path, { force: true });
    rmSync(anchorPath, { force: true });
    writeFileSync(path, keptMain.join("\n") + "\n");
    writeFileSync(anchorPath, keptAnchor.join("\n") + "\n");
    expect(existsSync(path)).toBe(true); // presence alone says "nothing happened"

    for (let i = 0; i < 24; i++) {
      a.record({ sessionId: "s", event: "x", decision: "block", reason: `after-swap-${i}` });
    }

    // Identity, not presence, is what catches it: once the handle is recognised
    // as pointing at a dead inode the next append re-roots the replacement file.
    const r = CryptoAuditTrail.verify(path);
    expect(r.valid).toBe(false);
    expect(readFileSync(path, "utf-8").trim().split("\n").length).toBeGreaterThan(3);
  });

  it("T2: deleting the SEED FILE and the era marker does not open a downgrade forgery", () => {
    // The marker used to be re-sealed on EVERY record from the cached in-memory
    // key. Latching it to once per daily file hands it to an attacker who
    // deletes it AFTER the first record — a latch has already fired by then.
    // That matters because hasPersistedAuditKey() reads the seed FILE from disk:
    // delete audit-key.enc as well and key-presence goes false while the live
    // writer keeps signing happily from its cache. Seed file gone + marker gone
    // + every row rewritten as legacy = all three era signals down at once, and
    // verify() accepts an unkeyed plain-SHA-256 forgery of the whole log.
    process.env.LAX_DATA_DIR = dataDir;
    delete process.env.LAX_AUDIT_KEY;
    // A FILE-backed seed, not the env override: hasPersistedAuditKey() returns
    // true unconditionally for LAX_AUDIT_KEY/_FILE, so only the on-disk seed can
    // be made to disappear. Force the keychain file fallback so minting the
    // sealed seed touches no OS keychain.
    const prevNoKeychain = process.env.LAX_DISABLE_OS_KEYCHAIN;
    process.env.LAX_DISABLE_OS_KEYCHAIN = "1";
    _resetAuditKeyCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      const a = new CryptoAuditTrail(dataDir);
      a.record({ sessionId: "s", event: "x", decision: "block", reason: "incriminating", threatScore: 99 });
      const path = dailyAuditPath();
      const markerPath = join(dataDir, "audit", ".hmac-v1.marker");
      expect(existsSync(join(dataDir, "audit-key.enc"))).toBe(true);
      expect(existsSync(markerPath)).toBe(true);

      // Attacker removes the sealed seed and the era marker. The live process
      // still holds the key in memory, so it keeps emitting valid hmac-v1 rows
      // and never notices. Records arrive sparsely (400ms apart, a realistic
      // tool-call cadence), which is the wall-clock leg of the tick.
      rmSync(join(dataDir, "audit-key.enc"), { force: true });
      rmSync(markerPath, { force: true });
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(new Date(Date.now() + 400));
        a.record({ sessionId: "s", event: "x", decision: "block", reason: `after-${i}` });
      }

      // Now the forgery: rewrite the entire log as a self-consistent plain
      // SHA-256 legacy chain (no key needed, no hashScheme tag) and drop the
      // anchor. Nothing keyed survives on disk except the re-sealed marker.
      rmSync(anchorPathOf(path), { force: true });
      let prev = "GENESIS";
      const forged: string[] = [];
      for (let i = 0; i < 6; i++) {
        const e: Record<string, unknown> = {
          seq: i, timestamp: new Date().toISOString(), sessionId: "s",
          event: "x", decision: "allow", reason: "innocuous", prevHash: prev,
        };
        e.hash = createHash("sha256").update(JSON.stringify({
          seq: e.seq, timestamp: e.timestamp, sessionId: e.sessionId, event: e.event,
          toolName: undefined, decision: e.decision, reason: e.reason, prevHash: e.prevHash,
        })).digest("hex");
        prev = e.hash as string;
        forged.push(JSON.stringify(e));
      }
      writeFileSync(path, forged.join("\n") + "\n");

      // THE security property, asserted first: pre-fix this returned
      // {valid:true, total:6} — the forged log accepted as authentic.
      const r = CryptoAuditTrail.verify(path);
      expect(r.valid).toBe(false);
      expect(r.brokenAt).toBe(0);

      // Why it holds: key-presence is gone and every surviving row is legacy, so
      // the RE-SEALED marker is the only signal still keeping the era open — it
      // has to carry the rejection on its own.
      expect(hasPersistedAuditKey()).toBe(false);
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      vi.useRealTimers();
      if (prevNoKeychain === undefined) delete process.env.LAX_DISABLE_OS_KEYCHAIN;
      else process.env.LAX_DISABLE_OS_KEYCHAIN = prevNoKeychain;
    }
  });
});
