// Full-chain regression: stateful poll loops must NOT hard-block.
//
// The break (adversarial verifier, 2026-07-23): exempting stateful tools from
// the resolvePhase session-repeat dedup means their identical repeats now flow
// through evaluateToolResult → chain.recordAndAnalyze → detectLoops, which is
// HASH-ONLY. Pre-fix these repeats halted before the audit phase so detectLoops
// never saw them. A legitimate poll (op_status ×12, agent_status↔agent_output
// ×8) would then hard-block, DISCARD the executed result — even one reporting
// the op COMPLETED — and replace it with a misleading "you're repeating…"
// message.
//
// These drive the REAL ThreatEngine.evaluateToolResult (not detectLoops in
// isolation), proving the whole chain lets stateful polls through while the
// global 40-call circuit breaker still stops a genuine runaway.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreatEngine } from "./threat-engine.js";

let seq = 0;
function freshEngine(): ThreatEngine {
  seq += 1;
  return new ThreatEngine(join(tmpdir(), `lax-stateful-loop-${process.pid}-${seq}`), `sess-${seq}`);
}

describe("ThreatEngine — stateful poll loops are not hard-blocked (full chain)", () => {
  it("a 15× identical op_status poll executes every call without a loop block", () => {
    const engine = freshEngine();
    for (let i = 0; i < 15; i++) {
      const r = engine.evaluateToolResult("op_status", { op_id: "op_42" }, `running (${i})`, true);
      expect(r.blocked, `call ${i}`).toBe(false);
      expect(r.loop, `call ${i}`).toBeFalsy();
    }
    // And the poll that finally reports completion is delivered, not swallowed.
    const done = engine.evaluateToolResult("op_status", { op_id: "op_42" }, "completed", true);
    expect(done.blocked).toBe(false);
  });

  it("a 12× identical browser snapshot poll is not flagged as a stuck loop", () => {
    const engine = freshEngine();
    let last;
    for (let i = 0; i < 12; i++) {
      last = engine.evaluateToolResult("browser", { action: "snapshot", full: true }, `<dom v${i}>`, true);
    }
    expect(last!.blocked).toBe(false);
    expect(last!.loop).toBeFalsy();
  });

  it("an 8× agent_status↔agent_output ping-pong does not trip the ping-pong arm", () => {
    const engine = freshEngine();
    let last;
    for (let i = 0; i < 4; i++) {
      engine.evaluateToolResult("agent_status", { agent_id: "a1" }, `status ${i}`, true);
      last = engine.evaluateToolResult("agent_output", { agent_id: "a1" }, `output ${i}`, true);
    }
    expect(last!.blocked).toBe(false);
    expect(last!.loop).toBeFalsy();
  });

  it("the 40-call circuit breaker STILL fires for a genuine runaway, even on an exempt tool", () => {
    const engine = freshEngine();
    let last;
    for (let i = 0; i < 40; i++) {
      last = engine.evaluateToolResult("op_status", { op_id: "stuck" }, "running", true);
    }
    expect(last!.blocked).toBe(true);
    expect(last!.loop).toBe(true);
    expect(last!.reason).toMatch(/Circuit breaker/);
  });

  it("a non-stateful read repeated 12× still trips the generic-repeat loop guard", () => {
    // Control: the exemption must be scoped — ordinary reads still loop-guard.
    const engine = freshEngine();
    let last;
    for (let i = 0; i < 12; i++) {
      last = engine.evaluateToolResult("read", { path: "x.ts" }, "same content", true);
    }
    expect(last!.blocked).toBe(true);
    expect(last!.loop).toBe(true);
    expect(last!.reason).toMatch(/Tool loop/);
  });
});
