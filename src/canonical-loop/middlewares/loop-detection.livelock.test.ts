/**
 * The recorded livelock, replayed on the WORKER lane through the real
 * middleware (not the guard functions directly).
 *
 * On the interactive lane the guard's cycle detector nudges and the nudge
 * ceiling ends the turn. On build/background the middleware passes
 * `deferWorkerPivot`, so every guard abort path returns abort:false and the
 * worker is given an autonomous strategy pivot instead — which rotated its
 * four strategies forever. The ONLY brake on a stuck worker was the wall
 * clock. Here the strategy pivot has a ceiling: once all four strategies have
 * been offered and no tool RESULT has been novel since the first of them, the
 * op is aborted with a note naming the cycle — the worker-lane analogue of the
 * interactive nudge ceiling.
 *
 * Renamed scratch files (`_scratch-<i>-<j>.html`, a NEW mutation target every
 * lap) are the point: the progress counter must keep counting them as
 * productive (write-only work is not dry — checkpoint-stop.ts), so the
 * checkpoint never stops this op; the cycle + pivot ceiling has to.
 */
import { describe, expect, it } from "vitest";
import { loopDetectionMiddleware } from "./loop-detection.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { LIVELOCK_SHAPES } from "../../agent-guards/livelock-shapes.test-helper.js";

let seq = 0;

interface Replay {
  /** Turn index at which the middleware aborted the op, or null. */
  abortedAt: number | null;
  abortMessage: string | null;
  /** Strategy pivots the worker was offered before the abort. */
  pivots: number;
  turns: number;
}

async function replay(
  shapes: readonly string[],
  lane: "build" | "background",
  result: (turn: number) => string,
  args: (turn: number, call: number) => Record<string, unknown> = (i, j) =>
    ({ path: `/w/_scratch-${i}-${j}.html`, url: `https://x/${i}` }),
): Promise<Replay> {
  const opId = `op-livelock-${++seq}`;
  let pivots = 0;
  for (let i = 0; i < shapes.length; i++) {
    const names = shapes[i].split(",");
    const toolCalls = names.map((tool, j) => ({ toolCallId: `t${i}-${j}`, tool, args: args(i, j) }));
    const ctx = makeCanonicalLoopContext({
      op: { id: opId, lane },
      model: "claude-opus-4-8",
      turnIdx: i,
      toolCalls,
      toolResults: toolCalls.map((tc) => ({ toolName: tc.tool, toolCallId: tc.toolCallId, content: result(i), status: "ok" as const })),
      toolNames: new Set<string>(),
      onEvent: () => {},
    });
    for (const phase of ["beforeTurn", "afterModelCall", "afterToolExecution"] as const) {
      const verdict = await loopDetectionMiddleware[phase]!(ctx);
      if (verdict.kind === "abort") return { abortedAt: i, abortMessage: verdict.message ?? null, pivots, turns: i + 1 };
      if (verdict.kind === "nudge" && verdict.reason === "strategy-pivot") pivots++;
    }
  }
  return { abortedAt: null, abortMessage: null, pivots, turns: shapes.length };
}

/** Enough laps of the recorded run to outlast any plausible ceiling. */
const LONG_RUN = Array.from({ length: 8 }, () => LIVELOCK_SHAPES).flat(); // 616 turns

describe("worker-lane strategy pivot ceiling — the recorded livelock ends at a bounded turn", () => {
  it.each(["build", "background"] as const)("%s lane: renamed scratch files + identical results abort after all four strategies fail", async (lane) => {
    const run = await replay(LONG_RUN, lane, () => "Both fixes are live on prod.");
    expect(run.abortedAt).not.toBeNull();
    // Bounded well inside the wall clock, and only after the worker was
    // actually offered every strategy: the ceiling is a last resort.
    expect(run.pivots).toBeGreaterThanOrEqual(4);
    expect(run.abortedAt!).toBeLessThan(LONG_RUN.length);
    expect(run.abortMessage).toMatch(/strategy-pivot ceiling/i);
    expect(run.abortMessage).toMatch(/no-progress/);
  });

  it("the same shapes with genuinely novel results never abort", async () => {
    const run = await replay(LONG_RUN, "build", (i) => `result number ${i} — new information`);
    expect(run.abortedAt).toBeNull();
    expect(run.pivots).toBe(0);
  });

  it("write-only work with distinct files and a constant 'ok' never aborts — no cycle in a constant shape", async () => {
    const shapes = Array.from({ length: 200 }, () => "write");
    const run = await replay(shapes, "build", () => "ok", (i) => ({ path: `/w/file-${i}.ts`, content: `v${i}` }));
    expect(run.abortedAt).toBeNull();
    expect(run.pivots).toBe(0);
  });

  it("a novel result after a pivot re-arms the ceiling — four more strategies before any abort", async () => {
    // Identical results until the third pivot has been offered, then one
    // turn of real information, then identical again. The ceiling must count
    // from that novel turn, not from the first pivot.
    let pivotsSeen = 0;
    let novelAt: number | null = null;
    const opId = `op-livelock-rearm`;
    let abortedAt: number | null = null;
    for (let i = 0; i < LONG_RUN.length && abortedAt === null; i++) {
      const names = LONG_RUN[i].split(",");
      const toolCalls = names.map((tool, j) => ({ toolCallId: `r${i}-${j}`, tool, args: { path: `/w/s-${i}-${j}.html`, url: `https://x/${i}` } }));
      const novel = pivotsSeen === 3 && novelAt === null;
      if (novel) novelAt = i;
      const ctx = makeCanonicalLoopContext({
        op: { id: opId, lane: "build" }, model: "claude-opus-4-8", turnIdx: i, toolCalls,
        toolResults: toolCalls.map((tc) => ({ toolName: tc.tool, toolCallId: tc.toolCallId, content: novel ? "something genuinely new" : "same old", status: "ok" as const })),
        toolNames: new Set<string>(), onEvent: () => {},
      });
      for (const phase of ["beforeTurn", "afterModelCall", "afterToolExecution"] as const) {
        const verdict = await loopDetectionMiddleware[phase]!(ctx);
        if (verdict.kind === "abort") { abortedAt = i; break; }
        if (verdict.kind === "nudge" && verdict.reason === "strategy-pivot") pivotsSeen++;
      }
    }
    expect(novelAt).not.toBeNull();
    expect(abortedAt).not.toBeNull();
    // Three pivots before the novel turn, then a full four-strategy cycle
    // AFTER it before the ceiling could fire: at least seven pivots total.
    expect(pivotsSeen).toBeGreaterThanOrEqual(7);
  });
});
