// What a worker's run that did not end cleanly counts as. A cancel halts (the
// build is never respawned behind a user's cancel), a crash or timeout goes
// back with the exit code and the error in the reason, and a worker that had
// already reported is reviewed on its work instead of being built again.

import { describe, it, expect } from "vitest";
import { chunkProcessFailureOutcome } from "./run-chunk-once.js";

const res = (exitCode: number, extra: { error?: string; durationMs?: number; reported?: boolean } = {}) => ({
  exitCode,
  durationMs: extra.durationMs ?? 1234,
  error: extra.error,
  reported: extra.reported,
});

describe("chunkProcessFailureOutcome", () => {
  it("returns null on a clean exit — caller proceeds to normal review", () => {
    expect(chunkProcessFailureOutcome(3, res(0), false)).toBeNull();
  });

  it("crash (exit 1) → push_back with an honest, exit-code-bearing reason", () => {
    const o = chunkProcessFailureOutcome(2, res(1, { error: "agent threw" }), false)!;
    expect(o.action).toBe("push_back");
    expect(o.reasoning).toContain("exit 1");
    expect(o.reasoning).toContain("agent threw");
    // No report, so nothing downstream reads a status the worker never gave.
    expect(o.report).toMatchObject({ reported: false, status: "unknown" });
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]).toMatchObject({ gate: "worker-run", action: "push_back" });
  });

  // A guard on a worker's last words can mark its run failed after it reported;
  // building the chunk again would throw away work that is there to measure.
  it("a worker that reported before its run was marked failed is reviewed, not respawned", () => {
    expect(chunkProcessFailureOutcome(2, res(1, { error: "ended on a promise", reported: true }), false)).toBeNull();
  });

  it("a report does not excuse a timeout or a cancel: the work may be half written", () => {
    expect(chunkProcessFailureOutcome(2, res(124, { reported: true }), false)!.action).toBe("push_back");
    expect(chunkProcessFailureOutcome(2, res(130, { reported: true }), false)!.action).toBe("halt");
    expect(chunkProcessFailureOutcome(2, res(1, { reported: true }), true)!.action).toBe("halt");
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

// The AGENTS panel read "Chunk 1011/4" for a finish-check fix (2026-11-25).
describe("chunkLabel", () => {
  it("names a plan chunk by its number and a finish fix by its place in the round", async () => {
    const { chunkLabel } = await import("./run-chunk-once.js");
    const chunk = (number: number, title: string, phase: string) => ({ number, title, phase }) as never;
    const plan = { chunks: [chunk(1011, "Finish fix 1: hostile findings", "Finish"), chunk(1012, "Finish fix 1: unlucky findings", "Finish")] } as never;
    expect(chunkLabel({ chunk: chunk(4, "Native scan", "Phase B"), plan, totalChunks: 5 })).toBe("Chunk 4/5: Native scan");
    expect(chunkLabel({ chunk: chunk(1012, "Finish fix 1: unlucky findings", "Finish"), plan, totalChunks: 2 })).toBe("Finish fix 1: unlucky findings (2 of 2)");
  });
});
