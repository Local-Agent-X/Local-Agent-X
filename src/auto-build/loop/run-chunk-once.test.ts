// Regression for the chunk-agent process-failure decision (theme-5 finding:
// "auto-build never inspects a chunk agent's exit code"). A killed / timed-out
// / aborted agent produces empty stdout; the old code fed that straight to the
// report parser, mislabeling it "no parseable report" and — worse — RETRYING a
// user-cancelled build. chunkProcessFailureOutcome branches on the exit code so
// a cancel halts (no respawn) and a crash/timeout push_backs with an honest
// reason.

import { describe, it, expect } from "vitest";
import { chunkProcessFailureOutcome } from "./run-chunk-once.js";

const res = (exitCode: number, extra: { error?: string; durationMs?: number } = {}) => ({
  exitCode,
  durationMs: extra.durationMs ?? 1234,
  error: extra.error,
});

describe("chunkProcessFailureOutcome", () => {
  it("returns null on a clean exit — caller proceeds to normal review", () => {
    expect(chunkProcessFailureOutcome(3, res(0), false)).toBeNull();
  });

  it("crash (exit 1) → push_back with an honest, exit-code-bearing reason (not 'no parseable report')", () => {
    const o = chunkProcessFailureOutcome(2, res(1, { error: "agent threw" }), false)!;
    expect(o.action).toBe("push_back");
    expect(o.reasoning).toContain("exit 1");
    expect(o.reasoning).toContain("agent threw");
    expect(o.reasoning).not.toMatch(/no parseable report/i);
    // Empty (unparsed) report so downstream gates never read stale fields.
    expect(o.report.parsed).toBe(false);
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]).toMatchObject({ gate: "report-shape", action: "push_back" });
  });

  it("timeout (exit 124) → push_back and names the timeout", () => {
    const o = chunkProcessFailureOutcome(1, res(124), false)!;
    expect(o.action).toBe("push_back");
    expect(o.reasoning).toContain("timed out");
    expect(o.reasoning).toContain("exit 124");
  });

  it("abort (exit 130) → halt, NOT push_back — a user cancel must not be respawned", () => {
    const o = chunkProcessFailureOutcome(4, res(130), false)!;
    expect(o.action).toBe("halt");
    expect(o.reasoning).toMatch(/cancelled|abort/i);
  });

  it("aborted signal wins over a non-abort exit code → halt", () => {
    // e.g. the agent exits 1 as it is torn down, but the caller's signal is
    // already aborted — respect the cancel, don't retry.
    const o = chunkProcessFailureOutcome(5, res(1), true)!;
    expect(o.action).toBe("halt");
  });

  it("falls back to a generic reason when the agent gave no error text", () => {
    const o = chunkProcessFailureOutcome(6, res(1), false)!;
    expect(o.reasoning).toContain("process exited without producing a report");
  });
});
