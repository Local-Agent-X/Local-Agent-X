/**
 * END-TO-END integration proof for the parallel auto-build engine (S3/S4).
 *
 * Unlike test/auto-build-parallel-waves.test.ts — which MOCKS the worktree lib
 * and the re-gate to test orchestration ordering in isolation — this test runs
 * the WHOLE engine against a REAL throwaway git repo with only the model-driven
 * per-chunk BUILD step stubbed (runChunkOnce). Everything else is production:
 *
 *   - REAL git repo (git init + real commits) as opts.projectDir,
 *   - REAL conflict-graph waves (planWaves groups chunks 1+2 into one wave,
 *     chunk 3 into a later wave because it dependsOn 1 & 2),
 *   - REAL worktrees (createNamedWorktree cuts autobuild-c1/c2/c3 from the
 *     project repo, NOT process.cwd()), REAL commitInWorktree + mergeWorktree,
 *   - REAL per-wave re-gate (runBuildExecGate) — the throwaway package.json has
 *     NO build/test script so the gate cleanly no-ops (we're proving the
 *     ORCHESTRATION + worktree/merge, not a real npm build).
 *
 * The stub for runChunkOnce writes a deterministic file (named after the chunk's
 * declared footprint) into the WORKTREE it was handed, and reports it CHANGED —
 * so the merge has real content to carry back and the assertions can observe it.
 *
 * What this proves that the mocked test cannot:
 *   1. chunks 1 & 2 really build in DISTINCT, isolated worktrees (neither sees
 *      the other's file at build time), both under the worktree base, both !=
 *      the project repo;
 *   2. all three chunks' work really merges back into ONE tree — the project
 *      repo's committed HEAD ends up with a.txt + b.txt + c.txt;
 *   3. chunk 3 (the dependent) really lands in a LATER wave — its worktree is
 *      cut AFTER wave 0 merged, so it already sees a.txt + b.txt on disk;
 *   4. the engine cleans up after itself — no leftover worktrees, no dangling
 *      autobuild/* branches in the project repo;
 *   5. status complete, chunksCommitted === 3.
 *
 * Hermetic: preflight is disabled (LAX_BUILD_PREFLIGHT=0 — it would spawn a real
 * agent), the temp repo + worktrees are torn down in afterEach, and NOTHING is
 * ever cut from the real LAX repo (createNamedWorktree is anchored to projectDir).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ── Captured per-invocation state from the stubbed runChunkOnce ──────────────
// One record per chunk build: the projectDir it was handed (the WORKTREE path in
// the parallel path), its workerIndex, and — captured BEFORE it writes its own
// file — whether each sibling file already existed in that worktree. The last is
// the deterministic proof of WAVE ORDERING: chunk 3's worktree is cut only after
// wave 0 merged, so it (and only it) sees a.txt + b.txt already present.
const shared = vi.hoisted(() => ({
  builds: [] as Array<{
    chunk: number;
    projectDir: string;
    workerIndex: number | undefined;
    sawA: boolean;
    sawB: boolean;
    sawC: boolean;
  }>,
}));

// The ONLY stub: the model-driven per-chunk build. For chunk N it writes
// `<N>.content` into the file named by the chunk's declared footprint (a.txt /
// b.txt / c.txt) inside the projectDir it was handed (its worktree), records the
// worktree state, and returns a `proceed` outcome reporting that file CHANGED.
// The worktree lib, the merge, the waves, and the re-gate are all REAL.
vi.mock("../src/auto-build/loop/run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: {
    chunk: { number: number; footprint?: string[] };
    projectDir: string;
    workerIndex?: number;
  }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = opts.projectDir;
    const footprintFile = opts.chunk.footprint?.[0] ?? `chunk${opts.chunk.number}.txt`;

    // Record worktree state BEFORE writing our own file, so `saw*` reflects only
    // files that got there via an earlier wave's merge — never our own write.
    shared.builds.push({
      chunk: opts.chunk.number,
      projectDir: dir,
      workerIndex: opts.workerIndex,
      sawA: fs.existsSync(path.join(dir, "a.txt")),
      sawB: fs.existsSync(path.join(dir, "b.txt")),
      sawC: fs.existsSync(path.join(dir, "c.txt")),
    });

    fs.writeFileSync(path.join(dir, footprintFile), `${opts.chunk.number}.content`);
    return makeProceed([footprintFile]);
  }),
  chunkProcessFailureOutcome: vi.fn(() => null),
}));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { parseChunkReport } = await import("../src/auto-build/chunk-review/report-parser.js");
const { WORKTREE_BASE } = await import("../src/agency/worktree-core.js");
const { cleanupWorktree } = await import("../src/agency/worktree.js");

/** A minimal `proceed` ChunkReviewOutcome whose report lists `changed`. */
function makeProceed(changed: string[]) {
  return {
    action: "proceed" as const,
    reasoning: "stub build proceeded",
    findings: [] as Array<{ gate: string; action: string; reasoning: string }>,
    report: { ...parseChunkReport(""), changed },
  };
}

// Chunk 1 (a.txt) + chunk 2 (b.txt) are disjoint with no deps → SAME wave, built
// in parallel. Chunk 3 (c.txt) dependsOn 1 & 2 → a LATER wave.
const PLAN = [
  "# E2E parallel engine plan",
  "## Phase A — Foundation",
  "### Chunk 1 — Alpha",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** create a.txt.",
  "- **Files:** a.txt",
  "- **Depends on:** —",
  "- **Done when:** a.txt exists.",
  "### Chunk 2 — Beta",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** create b.txt.",
  "- **Files:** b.txt",
  "- **Depends on:** —",
  "- **Done when:** b.txt exists.",
  "### Chunk 3 — Gamma",
  "- **Class:** leaf → `/vibe-code`",
  "- **Slice:** create c.txt.",
  "- **Files:** c.txt",
  "- **Depends on:** 1, 2",
  "- **Done when:** c.txt exists.",
].join("\n");

const WT_NAMES = ["autobuild-c1", "autobuild-c2", "autobuild-c3"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let projectDir: string;

beforeEach(() => {
  // Skip the preflight probe — it runs a real chunk-agent (a model call) that we
  // are neither stubbing nor want. It runs before path selection for BOTH paths.
  process.env.LAX_BUILD_PREFLIGHT = "0";
  shared.builds.length = 0;
  vi.clearAllMocks();

  // Pre-clean any worktree dirs a crashed prior run may have left (the names are
  // fixed by the engine: autobuild-c<n>). git worktree add fails if the path exists.
  for (const name of WT_NAMES) {
    try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Stand up a REAL throwaway repo with an initial commit. package.json has NO
  // build/test script, so the re-gate's build-exec gate cleanly no-ops.
  projectDir = mkdtempSync(join(tmpdir(), "parallel-e2e-"));
  git(projectDir, "init", "-q", "-b", "main");
  git(projectDir, "config", "user.email", "e2e@example.com");
  git(projectDir, "config", "user.name", "E2E Test");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "e2e-parallel", version: "0.0.0", private: true }, null, 2) + "\n");
  writeFileSync(join(projectDir, "README.md"), "# e2e parallel engine fixture\n");
  git(projectDir, "add", "-A");
  git(projectDir, "commit", "-qm", "init");
});

afterEach(() => {
  delete process.env.LAX_BUILD_PREFLIGHT;
  // Belt for the failure path: a green run already cleans up merged worktrees
  // inside mergeWorktree, but if an assertion threw mid-run these could leak.
  for (const name of WT_NAMES) {
    try { cleanupWorktree(name); } catch { /* not registered / already gone */ }
    try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("parallel auto-build engine — REAL worktrees, REAL merge, REAL waves, REAL re-gate", () => {
  it("builds 1+2 in parallel isolated worktrees, merges all three back, re-gates each wave, cleans up", async () => {
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "plan.md"),
      plan: parsePlanText(PLAN),
      startingChunk: 1,
      maxConcurrentChunks: 2, // > 1 → the parallel-wave path (beats config)
    });

    // ── (5) Terminal state: the whole engine completed with all 3 committed. ──
    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(3);
    expect(result.events.some((e) => e.type === "halt")).toBe(false);

    // Sanity: the stub really ran once per chunk (three real chunk builds).
    expect(shared.builds.map((b) => b.chunk).sort()).toEqual([1, 2, 3]);
    const b1 = shared.builds.find((b) => b.chunk === 1)!;
    const b2 = shared.builds.find((b) => b.chunk === 2)!;
    const b3 = shared.builds.find((b) => b.chunk === 3)!;

    // ── (1) Real parallel isolation: chunks 1 & 2 built in DISTINCT worktrees, ─
    //         both under the worktree base, both != the project repo dir.
    expect(b1.projectDir).not.toBe(b2.projectDir);
    expect(b1.projectDir).not.toBe(projectDir);
    expect(b2.projectDir).not.toBe(projectDir);
    expect(b1.projectDir.startsWith(WORKTREE_BASE)).toBe(true);
    expect(b2.projectDir.startsWith(WORKTREE_BASE)).toBe(true);
    // Isolation is real, not sequential-on-a-shared-tree: at build time neither
    // same-wave sibling saw the OTHER's file (it lived only in the peer worktree).
    expect(b1.sawB).toBe(false);
    expect(b2.sawA).toBe(false);
    // Each concurrently-dispatched chunk got a unique workerIndex (0 and 1).
    expect([b1.workerIndex, b2.workerIndex].sort()).toEqual([0, 1]);

    // ── (3) Real wave ordering: chunk 3 (dependsOn 1,2) built in a LATER wave, ─
    //         so its worktree — cut only after wave 0 merged — already had a.txt
    //         AND b.txt on disk. Wave-0 chunks saw neither at their build time.
    expect(b3.sawA).toBe(true);
    expect(b3.sawB).toBe(true);
    expect(b1.sawA).toBe(false); // chunk 1 wrote a.txt itself; didn't inherit it
    expect(b2.sawB).toBe(false);
    // Chunk 3 also built in its own worktree, not the base.
    expect(b3.projectDir).not.toBe(projectDir);
    expect(b3.projectDir.startsWith(WORKTREE_BASE)).toBe(true);

    // ── (2) Real merge-back into ONE tree: the PROJECT repo's committed HEAD ──
    //         now carries a.txt + b.txt + c.txt with the right contents.
    const tracked = git(projectDir, "ls-files").split("\n");
    expect(tracked).toContain("a.txt");
    expect(tracked).toContain("b.txt");
    expect(tracked).toContain("c.txt");
    expect(git(projectDir, "show", "HEAD:a.txt")).toBe("1.content");
    expect(git(projectDir, "show", "HEAD:b.txt")).toBe("2.content");
    expect(git(projectDir, "show", "HEAD:c.txt")).toBe("3.content");
    // The base working tree is clean (the fast-forward merges landed cleanly).
    expect(git(projectDir, "status", "--porcelain")).toBe("");

    // ── (4) Real teardown: no dangling autobuild/* branches, no leftover ──────
    //         worktrees registered on the project repo, no worktree dirs on disk.
    expect(git(projectDir, "branch", "--list", "autobuild/*")).toBe("");
    const worktreeList = git(projectDir, "worktree", "list", "--porcelain");
    expect(worktreeList).not.toContain("autobuild");
    for (const name of WT_NAMES) {
      expect(existsSync(join(WORKTREE_BASE, name))).toBe(false);
    }
  });
});
