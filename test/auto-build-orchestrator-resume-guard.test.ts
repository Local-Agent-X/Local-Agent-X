/**
 * Regression for AB-2 (double-orchestration guard) + AB-8 (resume window).
 *
 * AB-2: auto-resume claimed "running orchestrations are detected and skipped"
 *       but tryResumeOne had no such check — a second boot-scan started a
 *       duplicate loop on the same project_dir. Two loops interleave chunk
 *       agents and clobber `.lax-build-run.json`.
 *
 * AB-8: resume passed the ORIGINAL maxChunks alongside the advanced
 *       startingChunk, so "chunks 1-10" dying after 6 resumed as "7-16" —
 *       running chunks the user scoped out. And a crash between the final
 *       commit and the complete event left resumeAtChunk past the window,
 *       which the loop halts on as "starting_chunk not found" instead of
 *       recognizing completion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks: isolate resume.ts from the real loop, registry, and feature flag ──

let mockActive = false;
const startSpy = vi.fn((opts: { startingChunk: number; maxChunks?: number }) => ({
  opId: "op_test",
  initialMessage: `started at ${opts.startingChunk}`,
}));

vi.mock("../src/auto-build/orchestrator/manager.js", () => ({
  startOrchestration: (opts: unknown) => startSpy(opts as never),
  isActiveForProject: () => mockActive,
  listActive: () => [],
}));

let mockRegistry: Array<{ projectDir: string; opId: string; sessionId: string; registeredAt: string }> = [];
const unregisterSpy = vi.fn();
vi.mock("../src/auto-build/orchestrator/registry.js", () => ({
  listAll: () => mockRegistry,
  unregister: (dir: string) => unregisterSpy(dir),
}));

vi.mock("../src/auto-build/tool.js", () => ({
  isFeatureEnabled: () => true,
  FEATURE_FLAG_ENV: "LAX_TEST",
}));

vi.mock("../src/ops/session-bridge.js", () => ({
  broadcastToSession: vi.fn(),
}));

// The boot sweep that keeps a crashed chunk worktree; held open by a test to
// prove the resume waits for it.
let sweepCalls = 0;
let releaseSweep: () => void = () => {};
vi.mock("../src/agency/worktree-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sweepOrphanWorktreeJunctions: () => {
    sweepCalls++;
    return new Promise<void>((resolve) => { releaseSweep = resolve; });
  },
}));

vi.mock("../src/auto-build/chunk-review/judgment-hook.js", () => ({
  defaultJudgmentHook: {},
}));

import { autoResumeOrchestrations, computeResumeWindow, resumeOrchestrationsAtBoot } from "../src/auto-build/orchestrator/resume.js";
import { buildPlanResumeTool } from "../src/auto-build/orchestrator/tools.js";
import * as state from "../src/auto-build/orchestrator/state.js";

function makePlanChunks(chunkNumbers: number[]): string {
  const lines = ["# Test plan", ""];
  for (const n of chunkNumbers) {
    lines.push(
      `### Chunk ${n} — Feature ${n}`,
      `- **Class:** leaf`,
      `- **Slice:** implement feature ${n}.`,
      `- **Done when:** feature ${n} works.`,
      "",
    );
  }
  return lines.join("\n");
}

/** Seed a temp project with a plan + a persisted running state. */
function seedProject(opts: {
  totalChunks: number;
  startingChunkOverride: number;
  maxChunks: number | null;
  resumeAtChunk: number;
  chunkNumbers?: number[];
  currentChunk?: number;
  chunksCommitted?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-resume-"));
  const planPath = join(dir, "plan.md");
  const chunkNumbers = opts.chunkNumbers ?? Array.from({ length: opts.totalChunks }, (_, i) => i + 1);
  writeFileSync(planPath, makePlanChunks(chunkNumbers));

  const s = state.makeInitial({
    opId: "op_seed",
    sessionId: "sess_seed",
    projectDir: dir,
    planPath,
    totalChunks: chunkNumbers.length,
    startingChunk: opts.startingChunkOverride,
    maxChunks: opts.maxChunks ?? undefined,
  });
  // Advance to mid-run: N chunks committed, phase running.
  state.write({
    ...s,
    phase: "running",
    currentChunk: opts.currentChunk ?? opts.resumeAtChunk - 1,
    resumeAtChunk: opts.resumeAtChunk,
    chunksCommitted: opts.chunksCommitted ?? opts.resumeAtChunk - opts.startingChunkOverride,
  });
  return dir;
}

beforeEach(() => {
  mockActive = false;
  mockRegistry = [];
  startSpy.mockClear();
  sweepCalls = 0;
  unregisterSpy.mockClear();
});

// ── AB-8: pure window math ───────────────────────────────────────────────

describe("computeResumeWindow (AB-8)", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ number: i + 1 }));

  it("clamps maxChunks to the user's original window — 1-10 dying at 7 resumes as 7-10, not 7-16", () => {
    const s = { startingChunkOverride: 1, maxChunks: 10, currentChunk: 6, resumeAtChunk: 7, chunksCommitted: 6 } as state.OrchestratorState;
    const w = computeResumeWindow(s, chunks);
    expect(w.kind).toBe("resume");
    expect(w.startingChunk).toBe(7);
    expect(w.maxChunks).toBe(4); // 7,8,9,10 — NOT 10 (which would reach chunk 16)
  });

  it("keeps the window stable across a SECOND resume", () => {
    // After the first resume startOrchestration re-seeds override=7, maxChunks=4.
    const s = { startingChunkOverride: 7, maxChunks: 4, currentChunk: 8, resumeAtChunk: 9, chunksCommitted: 2 } as state.OrchestratorState;
    const w = computeResumeWindow(s, chunks);
    expect(w.maxChunks).toBe(2); // 9,10 — still ends at chunk 10
  });

  it("recognizes completion when resumeAtChunk is past the plan end (crash before complete event)", () => {
    const s = { startingChunkOverride: 1, maxChunks: null, currentChunk: 10, resumeAtChunk: 11, chunksCommitted: 10 } as state.OrchestratorState;
    expect(computeResumeWindow(s, chunks).kind).toBe("complete");
  });

  it("recognizes completion when every SCOPED chunk was committed but plan has more", () => {
    // Scope was chunks 1-6; resumeAtChunk=7 is outside scope though chunk 7 exists.
    const s = { startingChunkOverride: 1, maxChunks: 6, currentChunk: 6, resumeAtChunk: 7, chunksCommitted: 6 } as state.OrchestratorState;
    expect(computeResumeWindow(s, chunks).kind).toBe("complete");
  });

  it("runs to plan end when no maxChunks cap was set", () => {
    const s = { startingChunkOverride: 1, maxChunks: null, currentChunk: 3, resumeAtChunk: 4, chunksCommitted: 3 } as state.OrchestratorState;
    const w = computeResumeWindow(s, chunks);
    expect(w.kind).toBe("resume");
    expect(w.maxChunks).toBeUndefined();
  });
});

// ── AB-8 through the resume path ─────────────────────────────────────────

describe("autoResumeOrchestrations — window clamp (AB-8)", () => {
  it("passes the CLAMPED maxChunks to startOrchestration, not the original", () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    const report = autoResumeOrchestrations();

    expect(report.resumed).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const passed = startSpy.mock.calls[0][0];
    expect(passed.startingChunk).toBe(7);
    expect(passed.maxChunks).toBe(4); // pre-fix passed 10 → would overshoot to chunk 16
  });

  // label-check-sol's server died in its finish checks with every chunk landed;
  // the restart marked it complete and its chat never heard (2026-11-25).
  it("runs the build's end when every chunk landed, never a chunk past the plan", () => {
    // All 5 chunks committed; crash left resumeAtChunk=6 (past the plan).
    const dir = seedProject({ totalChunks: 5, startingChunkOverride: 1, maxChunks: null, resumeAtChunk: 6 });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    const report = autoResumeOrchestrations();

    expect(report.resumed).toBe(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const passed = startSpy.mock.calls[0][0] as { startingChunk: number; landedChunks?: number[] };
    expect(passed.startingChunk).toBe(1); // pre-AB-8 started chunk 6 → loop halts "not found"
    expect(passed.landedChunks).toEqual([1, 2, 3, 4, 5]); // the loop builds none of them again
  });

  it("resumes the next plan index when sparse numbering makes resumeAtChunk absent", () => {
    const dir = seedProject({
      totalChunks: 3,
      chunkNumbers: [1, 3, 5],
      startingChunkOverride: 1,
      maxChunks: 3,
      currentChunk: 1,
      resumeAtChunk: 2,
      chunksCommitted: 1,
    });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    const report = autoResumeOrchestrations();

    expect(report.resumed).toBe(1);
    expect(report.cleared).toBe(0);
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ startingChunk: 3, maxChunks: 2 }));
  });
});

describe("build_plan_resume — window clamp (AB-8)", () => {
  it("passes only the chunks remaining in the original max_chunks scope", async () => {
    const dir = seedProject({ totalChunks: 16, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });

    const result = await buildPlanResumeTool.execute({ project_dir: dir, _sessionId: "sess_resume" });

    expect(result.isError).not.toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const passed = startSpy.mock.calls[0][0];
    expect(passed.startingChunk).toBe(7);
    expect(passed.maxChunks).toBe(4);
    expect(result.metadata?.max_chunks).toBe(4);
  });

  it("on a scoped window whose chunks all landed, runs the build's end inside that window, never a chunk past it", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 6, resumeAtChunk: 7 });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    await buildPlanResumeTool.execute({ project_dir: dir });

    expect(startSpy).toHaveBeenCalledTimes(1);
    const passed = startSpy.mock.calls[0][0] as { startingChunk: number; maxChunks?: number; landedChunks?: number[] };
    expect(passed).toMatchObject({ startingChunk: 1, maxChunks: 6 });
    expect(passed.landedChunks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects a starting_chunk typo without altering persisted recovery state", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });
    const before = state.read(dir);

    const result = await buildPlanResumeTool.execute({ project_dir: dir, starting_chunk: 999 });

    expect(result.isError).toBe(true);
    expect(state.read(dir)).toEqual(before);
    expect(startSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it("rejects a backward starting_chunk override without altering state", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });
    const before = state.read(dir);

    const result = await buildPlanResumeTool.execute({ project_dir: dir, starting_chunk: 5 });

    expect(result.isError).toBe(true);
    expect(state.read(dir)).toEqual(before);
    expect(startSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it("rejects an override outside the original scoped window without altering state", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 6, resumeAtChunk: 5 });
    const before = state.read(dir);

    const result = await buildPlanResumeTool.execute({ project_dir: dir, starting_chunk: 7 });

    expect(result.isError).toBe(true);
    expect(state.read(dir)).toEqual(before);
    expect(startSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it("does not finalize or clear a completed window while its orchestration is live", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 6, resumeAtChunk: 7 });
    const before = state.read(dir);
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];
    mockActive = true;

    const result = await buildPlanResumeTool.execute({ project_dir: dir });

    expect(result.isError).toBe(true);
    expect(state.read(dir)).toEqual(before);
    expect(startSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();
  });
});

// ── AB-2 through the resume path ─────────────────────────────────────────

describe("autoResumeOrchestrations — idempotency guard (AB-2)", () => {
  it("skips (does NOT restart) a project already live in this process", () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];
    mockActive = true; // orchestration already running in-process

    const report = autoResumeOrchestrations();

    expect(startSpy).not.toHaveBeenCalled(); // pre-fix started a duplicate loop
    expect(report.skipped).toBe(1);
    expect(report.resumed).toBe(0);
  });
});

describe("autoResumeOrchestrations — deliberate halt reporting", () => {
  it("reports a halted build as waiting and leaves it resumable", () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: 10, resumeAtChunk: 7 });
    const persisted = state.read(dir)!;
    state.write(state.markHalted(persisted, 6, "phase-gate", "user review required"));
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    const report = autoResumeOrchestrations();

    expect(startSpy).not.toHaveBeenCalled();
    expect(report.waiting).toBe(1);
    expect(report.abandoned).toBe(0);
    expect(report.details[0]).toMatchObject({ outcome: "waiting" });
    expect(state.read(dir)?.phase).toBe("halted");
    expect(unregisterSpy).not.toHaveBeenCalled();
  });
});

// A crashed chunk's worktree is kept by the boot sweep, and only a kept one can
// be claimed by the resumed build. The sweep ran on its own 5 s after boot,
// after the resume had cut that chunk a fresh worktree: the work sat unclaimed.
describe("resumeOrchestrationsAtBoot — the worktree sweep runs first", () => {
  it("starts no build until the sweep has finished", async () => {
    const dir = seedProject({ totalChunks: 10, startingChunkOverride: 1, maxChunks: null, resumeAtChunk: 7 });
    mockRegistry = [{ projectDir: dir, opId: "op_seed", sessionId: "sess_seed", registeredAt: new Date().toISOString() }];

    const pending = resumeOrchestrationsAtBoot();
    await new Promise((r) => setTimeout(r, 10));
    expect(sweepCalls).toBe(1);
    expect(startSpy).not.toHaveBeenCalled();

    releaseSweep();
    const report = await pending;
    expect(report.resumed).toBe(1);
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ startingChunk: 7 }));
  });

  it("does not sweep when no build is registered", async () => {
    const report = await resumeOrchestrationsAtBoot();
    expect(sweepCalls).toBe(0);
    expect(report.attempted).toBe(0);
  });
});
