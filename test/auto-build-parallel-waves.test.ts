/**
 * Parallel-wave orchestration tests (S3) — exercise the NEW opt-in concurrent
 * path in runBuildLoop with the worktree lib + per-chunk build MOCKED, so we
 * test the orchestration logic (dispatch concurrency, SERIAL merge-back,
 * halt-on-conflict, null-worktree degrade, back-compat) without spawning real
 * agents or creating real git worktrees.
 *
 * The two NON-NEGOTIABLE correctness rules this file locks in:
 *   (1) builds run in parallel, MERGE-BACK RUNS SERIALLY (all builds finish
 *       before ANY merge; merges happen one at a time, in dispatch order);
 *   (2) a merge returning {merged:false} HALTS the whole build — the next
 *       wave's chunks are NEVER dispatched, the conflicting branch is named
 *       + preserved, and the other worktrees are cleaned up.
 * Plus: createNamedWorktree returning null degrades without crashing, and
 * maxConcurrentChunks=1 takes the serial path (worktree fns untouched).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Shared, per-test-mutable state referenced from the hoisted mock factory ──
const shared = vi.hoisted(() => ({
  /** Ordered log of orchestration side-effects: create/build-start/build-end/
   *  commit/merge/cleanup, so tests assert timing + ordering. */
  calls: [] as string[],
  /** chunkNumber → action returned by the mocked runChunkOnce ("proceed" default). */
  chunkActions: new Map<number, string>(),
  /** worktree name → mergeWorktree result (defaults to a clean merge). */
  mergeResults: new Map<string, { merged: boolean; files: number; error?: string }>(),
  /** worktree names for which createNamedWorktree returns null (cap reached). */
  nullNames: new Set<string>(),
  /** workerIndex threaded into each dispatched chunk's runChunkOnce. */
  workerIndices: [] as Array<{ chunk: number; workerIndex: number | undefined }>,
}));

// Mock the worktree lib — the whole point of the isolation.
vi.mock("../src/agency/worktree.js", () => ({
  createNamedWorktree: vi.fn((name: string, branch: string) => {
    shared.calls.push(`create:${name}`);
    if (shared.nullNames.has(name)) return null;
    return { path: `/fake-worktree/${name}`, branch, baseBranch: "main" };
  }),
  mergeWorktree: vi.fn((name: string) => {
    shared.calls.push(`merge:${name}`);
    return shared.mergeResults.get(name) ?? { merged: true, files: 1 };
  }),
  cleanupWorktree: vi.fn((name: string) => {
    shared.calls.push(`cleanup:${name}`);
  }),
  commitInWorktree: vi.fn((name: string) => {
    shared.calls.push(`commit:${name}`);
    return "deadbeefcafe";
  }),
}));

// Mock the per-chunk build so no real agent/review runs. Async with a small
// delay so concurrent dispatch is OBSERVABLE (both build-starts precede any
// build-end when two chunks run under Promise.all).
vi.mock("../src/auto-build/loop/run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: { chunk: { number: number }; workerIndex?: number }) => {
    shared.calls.push(`build-start:${opts.chunk.number}`);
    shared.workerIndices.push({ chunk: opts.chunk.number, workerIndex: opts.workerIndex });
    await new Promise((r) => setTimeout(r, 15));
    shared.calls.push(`build-end:${opts.chunk.number}`);
    const action = shared.chunkActions.get(opts.chunk.number) ?? "proceed";
    return makeOutcome(action);
  }),
  chunkProcessFailureOutcome: vi.fn(() => null),
}));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { parseChunkReport } = await import("../src/auto-build/chunk-review/report-parser.js");

function makeOutcome(action: string) {
  return {
    action,
    reasoning: action === "halt" ? "chunk gate halted the build" : `chunk ${action}`,
    findings: action === "halt" ? [{ gate: "build-exec", action: "halt", reasoning: "halt" }] : [],
    report: parseChunkReport(""),
  };
}

// Two disjoint-footprint chunks (no deps) → ONE wave of two parallel chunks.
const TWO_DISJOINT = [
  "# Test plan",
  "## Phase A — Foundation",
  "### Chunk 1 — Alpha",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** a.",
  "- **Files:** src/alpha.ts",
  "- **Depends on:** —",
  "- **Done when:** ok.",
  "### Chunk 2 — Beta",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** b.",
  "- **Files:** src/beta.ts",
  "- **Depends on:** —",
  "- **Done when:** ok.",
].join("\n");

// Wave 0 = {1,2} (disjoint), Wave 1 = {3} (depends on 1). Lets us prove that a
// halt in wave 0 never dispatches wave 1.
const TWO_WAVES = [
  TWO_DISJOINT,
  "### Chunk 3 — Gamma",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** c.",
  "- **Files:** src/gamma.ts",
  "- **Depends on:** 1",
  "- **Done when:** ok.",
].join("\n");

let projectDir: string;

beforeEach(() => {
  process.env.LAX_BUILD_PREFLIGHT = "0";
  shared.calls.length = 0;
  shared.chunkActions.clear();
  shared.mergeResults.clear();
  shared.nullNames.clear();
  shared.workerIndices.length = 0;
  vi.clearAllMocks();

  projectDir = mkdtempSync(join(tmpdir(), "parallel-waves-test-"));
  execSync("git init -q -b main", { cwd: projectDir });
  execSync("git config user.email test@example.com", { cwd: projectDir });
  execSync("git config user.name Test", { cwd: projectDir });
  mkdirSync(join(projectDir, "spec"));
  writeFileSync(join(projectDir, "spec", "plan.md"), TWO_DISJOINT);
  writeFileSync(join(projectDir, "README.md"), "# test\n");
  execSync("git add .", { cwd: projectDir });
  execSync("git commit -q -m init", { cwd: projectDir });
});

afterEach(() => {
  delete process.env.LAX_BUILD_PREFLIGHT;
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function run(planText: string, maxConcurrentChunks: number) {
  return runBuildLoop({
    projectDir,
    planPath: join(projectDir, "spec", "plan.md"),
    plan: parsePlanText(planText),
    startingChunk: 1,
    maxConcurrentChunks,
  });
}

describe("parallel path — rule 1: builds parallel, merge-back SERIAL", () => {
  it("dispatches both chunks concurrently, then merges them one at a time in order", async () => {
    const result = await run(TWO_DISJOINT, 2);

    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(2);

    // Concurrency: chunk 2 started BEFORE chunk 1 finished (Promise.all dispatch).
    const startC2 = shared.calls.indexOf("build-start:2");
    const endC1 = shared.calls.indexOf("build-end:1");
    expect(startC2).toBeGreaterThanOrEqual(0);
    expect(startC2).toBeLessThan(endC1);

    // Rule 1: EVERY build finished before ANY merge began.
    const lastBuildEnd = Math.max(shared.calls.indexOf("build-end:1"), shared.calls.indexOf("build-end:2"));
    const firstMerge = Math.min(shared.calls.indexOf("merge:autobuild-c1"), shared.calls.indexOf("merge:autobuild-c2"));
    expect(firstMerge).toBeGreaterThan(lastBuildEnd);

    // Merges are strictly serial + in dispatch order (c1 then c2).
    expect(shared.calls.indexOf("merge:autobuild-c1")).toBeLessThan(shared.calls.indexOf("merge:autobuild-c2"));

    // Each concurrent chunk got a UNIQUE workerIndex (0 and 1).
    const idxs = shared.workerIndices.map((w) => w.workerIndex).sort();
    expect(idxs).toEqual([0, 1]);
  });
});

describe("parallel path — rule 2: HALT on merge conflict, never auto-resolve", () => {
  it("stops the whole build, never dispatches the next wave, names + preserves the branch", async () => {
    // Chunk 1's merge textually conflicts.
    shared.mergeResults.set("autobuild-c1", { merged: false, files: 2, error: "CONFLICT in src/alpha.ts" });
    writeFileSync(join(projectDir, "spec", "plan.md"), TWO_WAVES);

    const result = await run(TWO_WAVES, 2);

    expect(result.status).toBe("halted");
    expect(result.lastChunk).toBe(1);
    // Branch is named + preserved in the halt reason.
    expect(result.haltReason).toContain("autobuild/c1");
    expect(result.haltReason.toLowerCase()).toContain("preserved");

    // Wave 1 (chunk 3) was NEVER dispatched — no worktree, no build.
    expect(shared.calls).not.toContain("create:autobuild-c3");
    expect(shared.calls).not.toContain("build-start:3");

    // The unmerged sibling (chunk 2) was cleaned up.
    expect(shared.calls).toContain("cleanup:autobuild-c2");
  });

  it("a chunk whose gate HALTS stops the build and merges NOTHING", async () => {
    shared.chunkActions.set(2, "halt");
    writeFileSync(join(projectDir, "spec", "plan.md"), TWO_WAVES);

    const result = await run(TWO_WAVES, 2);

    expect(result.status).toBe("halted");
    // No merge happened at all — a non-proceed chunk halts before the merge loop.
    expect(shared.calls.some((c) => c.startsWith("merge:"))).toBe(false);
    // Both worktrees cleaned up (nothing merged), wave 1 never dispatched.
    expect(shared.calls).toContain("cleanup:autobuild-c1");
    expect(shared.calls).toContain("cleanup:autobuild-c2");
    expect(shared.calls).not.toContain("create:autobuild-c3");
  });
});

describe("parallel path — createNamedWorktree null degrades gracefully", () => {
  it("runs the capped chunk serially on base after the parallel batch, no crash", async () => {
    shared.nullNames.add("autobuild-c2"); // chunk 2 can't get a worktree

    const result = await run(TWO_DISJOINT, 2);

    expect(result.status).toBe("complete");
    // Both chunks accounted for: c1 merged from its worktree, c2 committed serially on base.
    expect(result.chunksCommitted).toBe(2);
    // c1 went through a worktree merge; c2 never did (null → serial fallback).
    expect(shared.calls).toContain("create:autobuild-c1");
    expect(shared.calls).toContain("create:autobuild-c2");
    expect(shared.calls).toContain("merge:autobuild-c1");
    expect(shared.calls).not.toContain("merge:autobuild-c2");
  });
});

describe("back-compat — maxConcurrentChunks=1 takes the serial path", () => {
  it("never touches the worktree lib", async () => {
    const result = await run(TWO_DISJOINT, 1);

    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(2);
    // The load-bearing back-compat proof: NO worktree function was called.
    expect(shared.calls.some((c) => c.startsWith("create:"))).toBe(false);
    expect(shared.calls.some((c) => c.startsWith("merge:"))).toBe(false);
    expect(shared.calls.some((c) => c.startsWith("commit:"))).toBe(false);
    // workerIndex is undefined on the serial path (never assigned).
    expect(shared.workerIndices.every((w) => w.workerIndex === undefined)).toBe(true);
  });
});
