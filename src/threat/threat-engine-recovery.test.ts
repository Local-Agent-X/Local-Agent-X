import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine, THREAT_SCORES } from "./threat-engine.js";

// Unique data dir per engine so the shared audit trail doesn't collide.
let seq = 0;
function freshEngine(): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-threat-test-${process.pid}-${seq}`), `sess-${seq}`);
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
});
