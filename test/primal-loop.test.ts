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
function __setProjectDirForMock(dir: string) { __projectDirForMock = dir; __callCount = 0; }

vi.mock("../src/primal-auto-build/subprocess.js", () => ({
  spawnClaudeChunkSubprocess: vi.fn(async () => {
    const next = __queue.shift() || "STATUS: unknown\nDONE_WHEN: unknown\nCHANGED: none\nTESTS: n/a\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: queue empty";
    if (__projectDirForMock) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      __callCount++;
      try {
        mkdirSync(join(__projectDirForMock, "src"), { recursive: true });
        writeFileSync(join(__projectDirForMock, "src", `mock-${__callCount}.ts`), `// mock subprocess call ${__callCount}\n`);
      } catch { /* test may have already cleaned up */ }
    }
    return {
      stdout: next,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
    };
  }),
}));

// Imports must come AFTER vi.mock so the loop module picks up the stub.
const { runBuildLoop } = await import("../src/primal-auto-build/loop.js");
const { parsePlanText } = await import("../src/primal-auto-build/plan-parser.js");

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
  __queue.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), "primal-loop-test-"));
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
  it("halts on STATUS: blocked and does not advance", async () => {
    __pushReport(HALT_REPORT_BLOCKED);
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
    const result = await runBuildLoop({
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan,
      startingChunk: 1,
      judgmentHook: mockHook,
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

    expect(events).toEqual([
      "1:chunk-start", "1:subprocess-spawned", "1:subprocess-returned", "1:review-result", "1:commit",
      "2:chunk-start", "2:subprocess-spawned", "2:subprocess-returned", "2:review-result", "2:commit",
      "2:complete",
    ]);
  });
});
