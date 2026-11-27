// label-check-grok, 2026-11-27: the owner paused the build while the skeptic
// was reviewing finish fix 1015. The skeptic came back "did not finish (exit
// 130)", the review read that as "All gates passed", and the chunk landed.
// A review the stop cut off is no verdict: the chunk halts and is kept.
import { describe, expect, it, vi } from "vitest";

const controller = new AbortController();

vi.mock("../agents/chunk-runner.js", () => ({
  runChunkAgent: vi.fn(async () => ({ exitCode: 0, durationMs: 5, stdout: "", chunkReport: { status: "done", done_when: "met" } })),
}));
vi.mock("../git-helpers.js", () => ({
  chunkChangedFiles: vi.fn(async () => ["src/a.ts"]),
  gitDiffPath: vi.fn(async () => ""),
}));
vi.mock("../chunk-review/index.js", () => ({
  // The review runs, the owner pauses partway, and what comes back is a pass.
  runChunkReviewWithJudgment: vi.fn(async () => {
    controller.abort("paused");
    return { action: "proceed", reasoning: "All gates passed.", findings: [], report: { reported: true, status: "done" } };
  }),
}));

const { runChunkOnce } = await import("./run-chunk-once.js");

describe("a chunk whose review a stop cut off", () => {
  it("halts and is not landed on the review's pass", async () => {
    const events: { message: string }[] = [];
    const chunk = { number: 1015, title: "Finish fix 1: design findings", phase: "Finish", klass: "trunk", slice: "fix the design findings", dependsOn: [], footprint: [], scenarios: "—", doneWhen: "the findings are fixed", raw: "" } as never;
    const outcome = await runChunkOnce({
      chunk, totalChunks: 5, planPath: "spec/plan.md", plan: { chunks: [chunk] } as never,
      projectDir: "/tmp/x", preSha: "abc", signal: controller.signal, emit: (e) => events.push(e as never),
    });
    expect(outcome.action).toBe("halt");
    expect(outcome.reasoning).toContain("stopped during its review");
    expect(events.map((e) => e.message)).not.toContain("Review: proceed — All gates passed.");
  });
});
