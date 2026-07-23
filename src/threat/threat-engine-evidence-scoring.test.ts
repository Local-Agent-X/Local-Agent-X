import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine, THREAT_SCORES } from "./threat-engine.js";

// The session threat scorer accumulates risk ONLY from deterministic evidence
// (secret-carrying payloads, canaries, credentials/secrets in output) — never
// from heuristic/temporal signals (staging) or from other layers' block
// decisions (security_block). Regression for the 2026-07-23 "Clover incident":
// memory_search is always classified sensitive, so staging scoring turned
// every subsequent browser call into +12 risk and restricted a live session
// mid-task with zero actual evidence.

// Unique data dir per engine so the shared audit trail doesn't collide.
let seq = 0;
function freshEngine(sessionId?: string): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-threat-evidence-test-${process.pid}-${seq}`), sessionId ?? `sess-ev-${seq}`);
}

describe("ThreatEngine — evidence-only scoring", () => {
  it("one memory_search followed by many browser calls never restricts the session", () => {
    const engine = freshEngine();

    // Sensitive-by-definition memory access…
    engine.evaluateToolResult("memory_search", { query: "customer notes" }, "some recalled notes", true);

    // …followed by sustained ordinary browser work. Every one of these fires
    // the temporal-staging heuristic (memory read within the 15-min window).
    // Pre-fix each call scored exfiltration_staging (+12) and the session
    // crossed HIGH_THRESHOLD around call ~15. Args vary so the loop detector
    // never fires.
    for (let i = 0; i < 25; i++) {
      const res = engine.evaluateToolResult("browser", { url: `https://shop.example/page-${i}` }, "page ok", true);
      expect(res.blocked).toBe(false);
      expect(engine.isRestricted()).toBe(false);
    }

    // The heuristic must not have moved the score at all.
    expect(engine.scorer.getEvents().some(e => e.type === "exfiltration_staging")).toBe(false);
    expect(engine.scorer.getRawLoad()).toBe(0);

    // But staging remains an observability signal: the audit trail still
    // carries the exfiltration_staging_signal events.
    const audited = engine.audit.getRecent(200).filter(e => e.event === "exfiltration_staging_signal");
    expect(audited.length).toBeGreaterThanOrEqual(25);
    expect(audited[0].decision).toBe("allow");
  });

  it("a block from another security layer is audited but never scored", () => {
    const engine = freshEngine();

    for (let i = 0; i < 5; i++) {
      engine.evaluateToolResult("http_request", { url: `https://api.example/deny-${i}` }, "DENIED", false);
    }

    expect(engine.scorer.getEvents().some(e => e.type === "security_block")).toBe(false);
    expect(engine.scorer.getRawLoad()).toBe(0);
    expect(engine.isRestricted()).toBe(false);

    // The enforcement record is preserved.
    const blocked = engine.audit.getRecent(200).filter(e => e.event === "tool_blocked");
    expect(blocked.length).toBe(5);
    expect(blocked[0].decision).toBe("block");
  });

  it("genuine payload evidence still scores: credentials in a tool result", () => {
    const engine = freshEngine();

    const configBlob = '{ "provider": "xai", "apiKey": "sk-abcdefghijklmnopqrstuv" }';
    engine.evaluateToolResult("read", { path: "/tmp/some-config.json" }, configBlob, true);

    const events = engine.scorer.getEvents();
    expect(events.some(e => e.type === "credential_in_output")).toBe(true);
    expect(engine.scorer.getRawLoad()).toBeGreaterThanOrEqual(THREAT_SCORES.credential_in_output);
  });
});
