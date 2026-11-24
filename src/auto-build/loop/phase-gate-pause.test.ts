// A phase is scored through its closing chunk's review. When another chunk of
// the phase was set aside, the closing chunk landed unscored and the run that
// later landed the set-aside chunk never came back to the gate: the phase went
// unscored for good. The owed gate is now on record across runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import type { LoopEvent, LoopOptions } from "./types.js";

const scoring = vi.hoisted(() => ({
  result: { kind: "recovered" } as { kind: "recovered" } | { kind: "halt-with-context"; reason: string } | { kind: "no-spec" },
  scored: [] as number[],
}));
vi.mock("../loop-phase-gate.js", () => ({
  attemptPhaseGateScoring: vi.fn(async (_opts: unknown, chunk: ParsedChunk) => { scoring.scored.push(chunk.number); return scoring.result; }),
}));

const { createPhasePauseTracker } = await import("./phase-gate-pause.js");
const { owedPhaseGates } = await import("../failure-recovery.js");

const chunk = (number: number, phase: string): ParsedChunk => ({ number, title: `Chunk ${number}`, phase, dependsOn: [] }) as unknown as ParsedChunk;
// Phase A: chunks 1-3, closed by 3. Phase B: chunk 4.
const plan = [chunk(1, "Phase A"), chunk(2, "Phase A"), chunk(3, "Phase A"), chunk(4, "Phase B")];
const accepted = { action: "proceed", reasoning: "", findings: [] } as unknown as ChunkReviewOutcome;
const pausedAtGate = {
  action: "halt", reasoning: "Phase A: verification gate",
  findings: [{ gate: "phase-gate", action: "halt", reasoning: "Phase A: verification gate" }],
} as unknown as ChunkReviewOutcome;

let projectDir: string;
let events: LoopEvent[];
const scope = () => ({
  opts: { projectDir } as LoopOptions, totalChunks: plan.length,
  emit: (e: Omit<LoopEvent, "elapsedMs">) => { events.push({ ...e, elapsedMs: 0 }); },
  events, outcomes: [],
});
const tracker = (landedBefore: number[]) => createPhasePauseTracker({ projectDir, planChunks: plan, landedBefore });

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "lax-phase-pause-"));
  events = [];
  scoring.result = { kind: "recovered" };
  scoring.scored.length = 0;
});
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

describe("a phase's gate across runs", () => {
  it("scores a phase once its closing chunk and every other chunk of it have landed", async () => {
    const run = tracker([]);
    run.landed(plan[0], accepted);
    run.landed(plan[1], accepted);
    run.landed(plan[2], pausedAtGate);
    expect(await run.scoreFinished(scope(), 3)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([3]);
    expect(owedPhaseGates(projectDir)).toEqual({});
  });

  it("a phase with a chunk that did not land stays owed, and the run that lands it scores the phase", async () => {
    // Run 1: chunk 2 was set aside; 1 and the closing chunk 3 land.
    const first = tracker([]);
    first.landed(plan[0], accepted);
    first.landed(plan[2], pausedAtGate);
    expect(await first.scoreFinished(scope(), 2)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([]);
    expect(owedPhaseGates(projectDir)).toEqual({ "Phase A": { chunk: 3, reasoning: "Phase A: verification gate" } });

    // Run 2 builds only chunk 2: a new tracker, told what landed before.
    const second = tracker([1, 3]);
    expect(await second.scoreFinished(scope(), 0)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([]); // chunk 2 has not landed yet
    second.landed(plan[1], accepted);
    expect(await second.scoreFinished(scope(), 1)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([3]); // scored for the chunk that closes the phase
    expect(owedPhaseGates(projectDir)).toEqual({});
    // And only once.
    expect(await second.scoreFinished(scope(), 1)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([3]);
  });

  it("a closing chunk whose phase was scored where it was built owes nothing", async () => {
    const run = tracker([1, 2]);
    run.landed(plan[2], pausedAtGate, true);
    expect(await run.scoreFinished(scope(), 1)).toEqual({ kind: "ok" });
    expect(scoring.scored).toEqual([]);
    expect(owedPhaseGates(projectDir)).toEqual({});
  });

  it("a phase that fails its owed scoring halts with the reason, and is not asked again on the next run", async () => {
    tracker([]).landed(plan[2], pausedAtGate);
    scoring.result = { kind: "halt-with-context", reason: "Phase A: checkout scenario still 4/10" };

    const second = tracker([1, 3]);
    second.landed(plan[1], accepted);
    const result = await second.scoreFinished(scope(), 1);
    expect(result).toMatchObject({ kind: "halt", result: { status: "halted", lastChunk: 3, haltReason: "Phase A: checkout scenario still 4/10" } });
    expect(owedPhaseGates(projectDir)).toEqual({});
    expect(await tracker([1, 2, 3]).scoreFinished(scope(), 0)).toEqual({ kind: "ok" });
  });
});
