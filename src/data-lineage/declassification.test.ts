import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  getKernelTaintSources,
  checkEgressTaintWithPayload,
  declassifySession,
  declassifyTaintSource,
  _setDeclassifyAuditTrail,
} from "./index.js";
import { CryptoAuditTrail } from "../threat/audit-trail.js";

describe("declassification — deliberate, audited untaint (T2)", () => {
  // Each test points the declassify audit trail at a fresh temp dir so the
  // emitted event can be read back from the daily JSONL and the chain verified,
  // without touching the real ~/.lax audit log.
  let auditDir: string;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "lax-declassify-"));
    _setDeclassifyAuditTrail(new CryptoAuditTrail(auditDir));
  });

  afterEach(() => {
    _setDeclassifyAuditTrail(null);
    rmSync(auditDir, { recursive: true, force: true });
  });

  // Read the single daily audit file the temp trail wrote (parse JSONL → rows).
  function auditEntries(): Array<Record<string, unknown>> {
    const dir = join(auditDir, "audit");
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
    expect(files).toHaveLength(1);
    const path = join(dir, files[0]);
    return readFileSync(path, "utf-8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
  }
  function auditPath(): string {
    const dir = join(auditDir, "audit");
    return join(dir, readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"))[0]);
  }

  const SECRET_CONTENT = "BEGIN PRIVATE BLOB: super-secret-payload-marker-7f3a9c1e-quux-zonk END";

  it("declassifySession turns the egress gate from blocked → not-blocked", () => {
    const sid = "declass-1";
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    const res = declassifySession(sid, { reason: "user approved one-time export", authorizedBy: "operator" });
    expect(res.cleared).toBe(1);
    expect(res.sources).toEqual([{ source: "sensitive_file", target: "/home/u/.ssh/id_rsa" }]);

    // Only AFTER the explicit declassify does the gate stop blocking.
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("appends a verifiable audit event with reason + authorizedBy and NO fingerprinted content", () => {
    const sid = "declass-2";
    recordSensitiveRead(sid, "secret", "bash:blob", SECRET_CONTENT);
    declassifySession(sid, { reason: "released after manual review", authorizedBy: "alice@op" });

    const entries = auditEntries();
    const declass = entries.find(e => e.event === "taint_declassified");
    expect(declass).toBeDefined();
    expect(declass!.sessionId).toBe(sid);
    expect(String(declass!.reason)).toContain("released after manual review");
    expect(String(declass!.reason)).toContain("authorizedBy=alice@op");
    expect(declass!.role).toBe("alice@op");
    // Cleared source NAME is present; fingerprinted CONTENT never is.
    expect(String(declass!.reason)).toContain("secret:bash:blob");
    expect(JSON.stringify(declass)).not.toContain("super-secret-payload-marker");

    // The event landed on the tamper-evident chain and verifies.
    expect(CryptoAuditTrail.verify(auditPath()).valid).toBe(true);
  });

  it("declassifyTaintSource clears only the named source; other-source taint still blocks", () => {
    const sid = "declass-3";
    recordSensitiveRead(sid, "web", "http://evil.test");
    recordSensitiveRead(sid, "secret", "bash:openai-key");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    // Release web-derived taint only.
    const res = declassifyTaintSource(sid, "web", { reason: "web page was benign", authorizedBy: "user" });
    expect(res.cleared).toBe(1);
    expect(res.sources).toEqual([{ source: "web", target: "http://evil.test" }]);

    // Secret-derived taint remains → egress STILL blocked.
    expect(checkEgressTaint(sid).blocked).toBe(true);
    expect(getKernelTaintSources(sid)).toEqual(["rag"]);

    // Now release the secret too → clean.
    declassifyTaintSource(sid, "secret", { reason: "secret rotated", authorizedBy: "user" });
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("the silent clearSessionTaint path still works and writes NO audit event", () => {
    const sid = "declass-4";
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    clearSessionTaint(sid);
    expect(checkEgressTaint(sid).blocked).toBe(false);

    // New-chat reset is NOT a declassification — the audit trail stays empty.
    const dir = join(auditDir, "audit");
    expect(readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"))).toHaveLength(0);
  });

  it("nothing automatic untaints: checkEgressTaint alone never clears the session", () => {
    const sid = "declass-5";
    // Content-LESS read → unclearable under the completeness guard, so the floor
    // holds across repeated payload-aware checks too (this test is about no
    // AUTO-untaint, not the B+ clearable case).
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa");
    // Repeated gate checks (incl. payload-aware) must not mutate taint state.
    for (let i = 0; i < 5; i++) {
      expect(checkEgressTaint(sid).blocked).toBe(true);
      expect(checkEgressTaintWithPayload(sid, "benign outbound").blocked).toBe(true);
    }
    // Still blocked until an EXPLICIT declassify clears it.
    expect(checkEgressTaint(sid).blocked).toBe(true);
    declassifySession(sid, { reason: "explicit release", authorizedBy: "operator" });
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("declassifying an already-clean session still records the deliberate release", () => {
    const sid = "declass-6";
    const res = declassifySession(sid, { reason: "precautionary clear", authorizedBy: "operator" });
    expect(res.cleared).toBe(0);
    expect(res.sources).toEqual([]);
    // The deliberate action is itself on the record even with nothing to clear.
    const declass = auditEntries().find(e => e.event === "taint_declassified");
    expect(declass).toBeDefined();
    expect(String(declass!.reason)).toContain("(none)");
  });
});
