/**
 * Loop tests — exercise runBuildLoop against a temp git repo with a
 * mock-subprocess shim. We don't spawn a real Claude Code subprocess
 * here; instead we patch the loop module's subprocess import via
 * vitest's vi.doMock so each chunk gets a canned report.
 *
 * What we want to verify end-to-end:
 *   - proceed path commits a chunk
 *   - amend_spec path commits a spec amendment THEN the chunk
 *   - halt path stops the loop and returns the reasoning
 *   - push_back path retries once before halting if the retry also fails
 *   - the additive-diff gate refuses a synthetic weakening amendment
 *   - launch-readiness items get appended to LAUNCH_READINESS.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Hoisted mock for the subprocess module so the loop's spawn calls hit
// the queue we control per-test instead of executing real Claude Code.
const { __queue, __pushReport } = vi.hoisted(() => {
  const q: string[] = [];
  return {
    __queue: q,
    __pushReport(report: string) { q.push(report); },
  };
});

// Side-effect queue: each call to the mock writes a sentinel file into
// the project dir so gitCommit has something to commit. We tag the file
// by call count so concurrent chunks get distinct paths.
let __callCount = 0;
let __projectDirForMock = "";
let __writeAgentChanges = true;
function __setProjectDirForMock(dir: string) { __projectDirForMock = dir; __callCount = 0; }

vi.mock("../src/auto-build/agents/chunk-runner.js", () => ({
  runChunkAgent: vi.fn(async () => {
    const next = __queue.shift() || "STATUS: unknown\nDONE_WHEN: unknown\nCHANGED: none\nTESTS: n/a\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: queue empty";
    if (__projectDirForMock && __writeAgentChanges) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      __callCount++;
      try {
        mkdirSync(join(__projectDirForMock, "src"), { recursive: true });
        writeFileSync(join(__projectDirForMock, "src", `mock-${__callCount}.ts`), `// mock agent call ${__callCount}\n`);
      } catch { /* test may have already cleaned up */ }
    }
    return {
      stdout: next,
      exitCode: 0,
      durationMs: 50,
    };
  }),
}));

vi.mock("../src/auto-build/advisor/index.js", () => ({
  consultAdvisor: vi.fn(async () => null),
}));


// Imports must come AFTER vi.mock so the loop module picks up the stub.
const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");

const TWO_CHUNK_PLAN = [
  "# Test plan",
  "",
  "## Phase A — Foundation",
  "",
  "### Chunk 1 — Skeleton",
  "- **Class:** trunk → `/senior-engineer`",
  "- **Slice:** repo init.",
  "- **Depends on:** —",
  "- **Scenarios:** —",
  "- **Done when:** boots.",
  "",
  "### Chunk 2 — Feature",
  "- **Class:** trunk → `/senior-engineer`",
  "- **Slice:** add a thing.",
  "- **Depends on:** 1",
  "- **Scenarios:** —",
  "- **Done when:** feature works.",
].join("\n");

const CLEAN_REPORT = (changedFile: string) =>
  `STATUS: done\nDONE_WHEN: met\nCHANGED: ${changedFile}\nTESTS: 1/1\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: clean.`;

const HALT_REPORT_BLOCKED =
  `STATUS: blocked\nDONE_WHEN: unmet\nCHANGED: none\nTESTS: n/a\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: needs creds.`;

const AMEND_REPORT = (gapsText: string) =>
  `STATUS: done\nDONE_WHEN: met\nCHANGED: src/feature.ts\nTESTS: 3/3\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: ${gapsText}\nLAUNCH_READINESS: none\nNOTE: clean. Spec was missing a constraint.`;

const LAUNCH_READINESS_REPORT =
  `STATUS: done\nDONE_WHEN: met\nCHANGED: src/feature.ts\nTESTS: 2/2\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: Apple Sign In e2e — set APPLE_* envs, run real OAuth round-trip, assert session cookie issued.\nNOTE: clean.`;

let projectDir: string;

function git(cmd: string) {
  return execSync(`git ${cmd}`, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

beforeEach(() => {
  // These tests exercise the chunk loop, not the environment probe — the
  // probe would consume the first queued mock report. It has its own suite
  // (auto-build-preflight.test.ts).
  process.env.LAX_BUILD_PREFLIGHT = "0";
  // The loop's git runs through the shell cage seam; on a box with the
  // Windows cage installed the default would prove and use the real cage,
  // whose account cannot read this temp repo.
  process.env.LAX_SANDBOX = "host";
  __queue.length = 0;
  __writeAgentChanges = true;
  projectDir = mkdtempSync(join(tmpdir(), "auto-build-loop-test-"));
  __setProjectDirForMock(projectDir);
  // Initialize a real git repo so the loop's git helpers work.
  execSync("git init -q -b main", { cwd: projectDir });
  execSync("git config user.email test@example.com", { cwd: projectDir });
  execSync("git config user.name Test", { cwd: projectDir });
  mkdirSync(join(projectDir, "spec"));
  writeFileSync(join(projectDir, "spec", "plan.md"), TWO_CHUNK_PLAN);
  writeFileSync(join(projectDir, "README.md"), "# Test repo\n");
  execSync("git add .", { cwd: projectDir });
  execSync("git commit -q -m init", { cwd: projectDir });
});

afterEach(() => {
  delete process.env.LAX_BUILD_PREFLIGHT;
  delete process.env.LAX_SANDBOX;
  vi.clearAllMocks();
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("runBuildLoop — proceed path", () => {
  it("commits each chunk when reports are clean", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
    });

    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(2);
    expect(result.outcomes.map(o => o.action)).toEqual(["proceed", "proceed"]);

    const log = git("log --format=%s");
    expect(log).toContain("chunk 1: Skeleton");
    expect(log).toContain("chunk 2: Feature");
  });
});

describe("runBuildLoop — halt path", () => {
  // A blocked worker is sent back once with what to do (gate-done-when.ts);
  // blocked the same way again, the round changed nothing and the chunk does
  // not land. Nothing else can build without it here, so the run ends.
  it("sends a blocked worker back, and stops when the retry is blocked the same way", async () => {
    __pushReport(HALT_REPORT_BLOCKED);
    __pushReport(HALT_REPORT_BLOCKED);            // the fix round
    __pushReport(CLEAN_REPORT("src/feature.ts")); // queued but should not be consumed

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
    });

    expect(result.status).toBe("halted");
    expect(result.lastChunk).toBe(1);
    expect(result.chunksCommitted).toBe(0);
    expect(result.haltReason.toLowerCase()).toContain("blocked");

    const log = git("log --format=%s");
    expect(log).not.toContain("chunk 1: Skeleton");
    expect(log).not.toContain("chunk 2: Feature");
  });

  // One chunk that cannot go green no longer costs the chunks that do not
  // depend on it: its work leaves the tree for a branch and the build goes on.
  const THREE_CHUNK_PLAN = [
    TWO_CHUNK_PLAN,
    "",
    "### Chunk 3 — Independent",
    "- **Class:** leaf → `/vibe-code`",
    "- **Slice:** a part nothing waits on.",
    "- **Depends on:** —",
    "- **Scenarios:** —",
    "- **Done when:** it works.",
  ].join("\n");

  it("sets the failed chunk aside on a branch, holds back what depends on it, and builds the rest", async () => {
    __pushReport(HALT_REPORT_BLOCKED);            // chunk 1
    __pushReport(HALT_REPORT_BLOCKED);            // chunk 1's fix round, blocked the same way
    __pushReport(CLEAN_REPORT("src/mock-3.ts"));  // chunk 3 (chunk 2 waits on 1)
    writeFileSync(join(projectDir, "spec", "plan.md"), THREE_CHUNK_PLAN);
    git("commit -qam plan");

    const result = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(THREE_CHUNK_PLAN), startingChunk: 1,
    });

    expect(result.status).toBe("halted");
    expect(result.chunksCommitted).toBe(1);
    expect(result.haltReason).toContain("Landed this run: chunk 3.");
    expect(result.haltReason).toContain("Set aside — chunk 1 (Skeleton)");
    expect(result.haltReason).toContain("Its work is on branch 'autobuild/c1'.");
    expect(result.haltReason).toContain("waiting on those: chunk 2 (on 1)");
    expect(result.events.filter(e => e.type === "chunk-landed").map(e => e.chunkNumber)).toEqual([3]);

    // Chunk 1's work is on its branch and out of the tree chunk 3 built in.
    expect(git("show autobuild/c1:src/mock-1.ts")).toContain("mock agent call 1");
    expect(existsSync(join(projectDir, "src", "mock-1.ts"))).toBe(false);
    const log = git("log --format=%s main");
    expect(log).toContain("chunk 3: Independent");
    expect(log).not.toContain("chunk 1");
    expect(git("status --porcelain").trim()).toBe("");
    // On record for the next run to pick up.
    const history = JSON.parse(readFileSync(join(projectDir, ".lax-build-history.json"), "utf-8"));
    expect(history.setAside["1"].branch).toBe("autobuild/c1");
  });

  it("the next run picks the set-aside chunk up from its branch, then builds what waited on it", async () => {
    writeFileSync(join(projectDir, "spec", "plan.md"), THREE_CHUNK_PLAN);
    git("commit -qam plan");
    const run = (landedChunks: number[]) => runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(THREE_CHUNK_PLAN), startingChunk: 1, landedChunks,
    });
    __pushReport(HALT_REPORT_BLOCKED);
    __pushReport(HALT_REPORT_BLOCKED);            // its fix round, blocked the same way
    __pushReport(CLEAN_REPORT("src/mock-3.ts"));
    await run([]);

    __pushReport(CLEAN_REPORT("src/mock-4.ts"));  // chunk 1 again
    __pushReport(CLEAN_REPORT("src/mock-5.ts"));  // chunk 2
    const resumed = await run([3]);

    expect(resumed.status).toBe("complete");
    expect(resumed.events.some(e => e.message.includes("picks up the last run's work from 'autobuild/c1'"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "mock-1.ts"))).toBe(true); // the first run's work came back
    expect(resumed.events.filter(e => e.type === "chunk-landed").map(e => e.chunkNumber)).toEqual([1, 2]);
    const history = JSON.parse(readFileSync(join(projectDir, ".lax-build-history.json"), "utf-8"));
    expect(history.setAside ?? {}).toEqual({});
  });

  // A restart after every chunk landed resumes with all of them landed
  // (orchestrator/resume.ts): nothing is built again, and the run still ends
  // complete on the plan's last chunk, which is what sends it on to the finish
  // checks, the lead's ledger and the report (label-check-sol, 2026-11-25).
  it("a run whose chunks all landed builds none and ends complete on the plan's last chunk", async () => {
    writeFileSync(join(projectDir, "spec", "plan.md"), THREE_CHUNK_PLAN);
    git("commit -qam plan");
    const plan = parsePlanText(THREE_CHUNK_PLAN);
    const ended = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan, startingChunk: 1, landedChunks: plan.chunks.map((c) => c.number),
    });
    expect(ended.status).toBe("complete");
    expect(ended.lastChunk).toBe(plan.chunks.at(-1)!.number);
    expect(ended.events.filter((e) => e.type === "chunk-start")).toEqual([]);
  });
});

describe("runBuildLoop — amend_spec path", () => {
  it("appends to spec/build-state.md, commits the spec, then commits the chunk", async () => {
    // We can't trigger amend_spec from the mechanical gates directly —
    // they halt rather than amend. But we can force the path by
    // crafting a report whose only finding is benign and whose SPEC_GAPS
    // is non-empty. The current gate logic returns "proceed" in this
    // case, so amend_spec is reached only when the LLM judgment hook
    // (future) classifies it. For now, this test documents the gate
    // behavior: SPEC_GAPS text alone doesn't trigger amend_spec; loop
    // commits the chunk normally.
    __pushReport(AMEND_REPORT("Stale-data warning must show on degraded connections."));
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
    });

    expect(result.status).toBe("complete");
    // Without an LLM judgment hook, this is currently "proceed" — the
    // SPEC_GAPS text is recorded in the outcome but not auto-applied.
    expect(result.outcomes[0].action).toBe("proceed");
    expect(result.outcomes[0].outcome.report.specGaps).toContain("Stale-data warning");
  });

  it("with a judgmentHook that fires, appends to spec/build-state.md and commits spec then chunk", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    let callCount = 0;
    const mockHook = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          specGap: "Booking page must show stale-data notice on degraded connections.",
          reasoning: "Constitution #8 — no silent failures applied to degraded calendar render.",
        };
      }
      return null;
    };

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const events: Array<{ type: string; chunkNumber: number }> = [];
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
      judgmentHook: mockHook,
      onEvent: e => events.push(e),
    });

    expect(result.status).toBe("complete");
    expect(result.outcomes[0].action).toBe("amend_spec");
    expect(result.outcomes[1].action).toBe("proceed");

    const buildStatePath = join(projectDir, "spec", "build-state.md");
    expect(existsSync(buildStatePath)).toBe(true);
    expect(readFileSync(buildStatePath, "utf-8")).toContain("stale-data notice");

    const log = git("log --format=%s");
    expect(log).toContain("spec: chunk-1 learned");
    expect(log).toContain("chunk 1: Skeleton");
    expect(log).toContain("chunk 2: Feature");
    expect(events.filter(e => e.chunkNumber === 1 && e.type === "commit")).toHaveLength(2);
    expect(events.filter(e => e.chunkNumber === 1 && e.type === "chunk-landed")).toHaveLength(1);
  });

  it("with a judgmentHook returning null, no amend_spec fires", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    const nullHook = async () => null;
    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
      judgmentHook: nullHook,
    });

    expect(result.status).toBe("complete");
    expect(result.outcomes.every(o => o.action === "proceed")).toBe(true);
    expect(existsSync(join(projectDir, "spec", "build-state.md"))).toBe(false);
  });
});

describe("runBuildLoop — launch-readiness emission", () => {
  it("appends concrete launch-readiness items to LAUNCH_READINESS.md", async () => {
    __pushReport(LAUNCH_READINESS_REPORT);
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
    });

    expect(result.status).toBe("complete");
    const lrPath = join(projectDir, "LAUNCH_READINESS.md");
    expect(existsSync(lrPath)).toBe(true);
    const body = readFileSync(lrPath, "utf-8");
    expect(body).toContain("Apple Sign In");
    expect(body).toContain("set APPLE_*");
  });
});

describe("runBuildLoop — startingChunk + maxChunks", () => {
  it("respects starting_chunk and max_chunks", async () => {
    __pushReport(CLEAN_REPORT("src/feature.ts")); // for chunk 2 only

    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 2,
      maxChunks: 1,
    });

    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].chunkNumber).toBe(2);
    const log = git("log --format=%s");
    expect(log).toContain("chunk 2: Feature");
    expect(log).not.toContain("chunk 1: Skeleton");
  });

  it("halts when starting_chunk is not in the plan", async () => {
    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 99,
    });
    expect(result.status).toBe("halted");
    expect(result.haltReason).toContain("starting_chunk=99");
  });
});

describe("runBuildLoop — event stream", () => {
  it("emits ordered events for a clean two-chunk run", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/feature.ts"));

    const events: string[] = [];
    const plan = parsePlanText(TWO_CHUNK_PLAN);
    await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
      onEvent: e => events.push(`${e.chunkNumber}:${e.type}`),
    });

    // The project has no build or test script: each chunk says it was not
    // built or tested (chunk-review/index.ts `unverified`) before its verdict.
    expect(events).toEqual([
      "1:chunk-start", "1:subprocess-spawned", "1:subprocess-returned", "1:review-result", "1:review-result", "1:commit", "1:chunk-landed",
      "2:chunk-start", "2:subprocess-spawned", "2:subprocess-returned", "2:review-result", "2:review-result", "2:commit", "2:chunk-landed",
      "2:complete",
    ]);
  });

  it("lands a clean no-change chunk exactly once", async () => {
    __writeAgentChanges = false;
    __pushReport(CLEAN_REPORT("none"));
    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan,
      startingChunk: 1, maxChunks: 1,
    });
    expect(result.chunksCommitted).toBe(1);
    expect(result.events.filter(e => e.type === "commit")).toHaveLength(1);
    expect(result.events.filter(e => e.type === "chunk-landed")).toHaveLength(1);
  });

  it("lands a chunk once after a push-back retry succeeds", async () => {
    __pushReport("not a chunk report");
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    const plan = parsePlanText(TWO_CHUNK_PLAN);
    const result = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan,
      startingChunk: 1, maxChunks: 1,
    });
    expect(result.status).toBe("complete");
    expect(result.events.filter(e => e.type === "subprocess-spawned")).toHaveLength(2);
    expect(result.events.filter(e => e.type === "chunk-landed")).toHaveLength(1);
  });
});

describe("runBuildLoop — chunk judging (held-out scenarios + skeptic)", () => {
  type Judging = import("../src/auto-build/chunk-review/chunk-verdict.js").ChunkJudging;
  const green: Judging = {
    scenarios: { status: "scored", reason: "", scores: [{ file: "01-boot.md", score: 9, passed: true, reasoning: "boots", failedCriteria: [] }] },
    skeptic: { status: "holds", finding: "tried an empty config" },
  };
  const broken: Judging = { ...green, skeptic: { status: "broken", finding: "SKEPTIC-FINDING: crashes on an empty config" } };

  it("a failed judging sends the chunk back once with the finding, then lands it when the retry is green", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    const verdicts = [broken, green];
    const judgeInputs: Array<{ baseProjectDir: string; preSha: string }> = [];
    const result = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(TWO_CHUNK_PLAN),
      startingChunk: 1, maxChunks: 1,
      chunkJudge: async (input) => { judgeInputs.push(input); return verdicts.shift()!; },
    });
    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(1);
    expect(judgeInputs).toHaveLength(2);
    expect(judgeInputs[0].baseProjectDir).toBe(projectDir);
    expect(judgeInputs[0].preSha).toMatch(/^[0-9a-f]{40}$/);
    // The retry worker was told what the skeptic found.
    const { runChunkAgent } = await import("../src/auto-build/agents/chunk-runner.js");
    const retryTask = (vi.mocked(runChunkAgent).mock.calls[1][0] as { task: string }).task;
    expect(retryTask).toContain("SKEPTIC-FINDING: crashes on an empty config");
    expect(result.outcomes[0].outcome.judging?.skeptic.status).toBe("holds");
    expect(result.events.some(e => e.message.includes("judged: scenarios 1/1 passed"))).toBe(true);
  });

  it("a chunk that fails judging twice halts the build with the finding", async () => {
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    __pushReport(CLEAN_REPORT("src/skeleton.ts"));
    const result = await runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(TWO_CHUNK_PLAN),
      startingChunk: 1,
      chunkJudge: async () => broken,
    });
    expect(result.status).toBe("halted");
    expect(result.chunksCommitted).toBe(0);
    expect(result.haltReason).toContain("SKEPTIC-FINDING");
    expect(git("log --format=%s")).not.toContain("chunk 1: Skeleton");
  });
});
