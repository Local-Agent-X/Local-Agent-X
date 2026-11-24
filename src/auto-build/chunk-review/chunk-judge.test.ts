// Judging one chunk: which sealed scenarios it is scored on, where the app is
// started from (a worktree finds the suite by the base project's name), the
// verdict a judging produces, and the stage's place in the chunk review.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({
  scoreCalls: [] as Array<{ projectDir: string; scenarioPaths: string[]; workerIndex?: number }>,
  scoreOutcome: null as unknown,
  skeptic: { status: "holds", finding: "tried hard" } as { status: string; finding: string },
  skepticCalls: 0,
}));

vi.mock("../scenario-scorer/phase-gate-runner.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../scenario-scorer/phase-gate-runner.js")>();
  return {
    ...real,
    scoreScenarioFiles: vi.fn(async (opts: { projectDir: string; scenarioPaths: string[]; workerIndex?: number }) => {
      fake.scoreCalls.push({ projectDir: opts.projectDir, scenarioPaths: opts.scenarioPaths, workerIndex: opts.workerIndex });
      return fake.scoreOutcome;
    }),
  };
});

vi.mock("./skeptic.js", () => ({
  runChunkSkeptic: vi.fn(async () => { fake.skepticCalls++; return fake.skeptic; }),
}));

const { scoreChunkScenarios, defaultChunkJudge } = await import("./chunk-judge.js");
const { chunkJudgingFinding, chunkJudgingSummary } = await import("./chunk-verdict.js");
const { runChunkReviewWithJudgment, isPhaseGatePause } = await import("./index.js");
const { writeScenario } = await import("../../holdout/store.js");
const { parsePlanText } = await import("../plan-parser.js");
type ChunkJudging = import("./chunk-verdict.js").ChunkJudging;

const DATA = mkdtempSync(join(tmpdir(), "lax-chunk-judge-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => {
  process.env.LAX_DATA_DIR = DATA;
  writeScenario("shopapp", "01-browse.md", "x");
  writeScenario("shopapp", "02-checkout.md", "x");
  writeScenario("shopapp", "03-refund.md", "x");
});
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const plan = (scenarios: string) => parsePlanText([
  "# Plan",
  "## Phase A — Core",
  "### Chunk 4 — Checkout",
  "- **Class:** trunk → `/senior-engineer`",
  "- **Slice:** pay for the cart.",
  "- **Depends on:** —",
  `- **Scenarios:** ${scenarios}`,
  "- **Done when:** an order is recorded.",
].join("\n"));

function projectDirs() {
  const base = join(mkdtempSync(join(DATA, "ws-")), "shopapp");
  const worktree = join(DATA, `autobuild-c4-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { base, worktree };
}
const launch = (dir: string) => writeFileSync(join(dir, ".lax-launch.json"), JSON.stringify({ start: "npm run dev", ready_url: "http://localhost:5173" }));

function input(scenarios: string, dirs: { base: string; worktree: string }, extra: Record<string, unknown> = {}) {
  return { chunk: plan(scenarios).chunks[0], rawReport: "STATUS: done", preSha: "abc", projectDir: dirs.worktree, baseProjectDir: dirs.base, ...extra };
}

const report = (file: string, score: number) => ({
  scenarioPath: join(DATA, "holdout", "shopapp", file), scenarioTitle: file, score, passed: score >= 7,
  steps: [{ index: 1, text: "SECRET STEP TEXT", action: "click", outcome: "ok", status: "ok", consoleErrors: [], networkFailures: [] }],
  metCriteria: [], failedCriteria: score >= 7 ? [] : ["order total shown"], reasoning: `judge saw ${score}`, durationMs: 1,
});

beforeEach(() => {
  fake.scoreCalls.length = 0;
  fake.scoreOutcome = null;
  fake.skeptic = { status: "holds", finding: "tried hard" };
  fake.skepticCalls = 0;
});

describe("scoreChunkScenarios", () => {
  it("a chunk that names no scenario is not scored (no whole-suite fallback)", async () => {
    const dirs = projectDirs(); launch(dirs.base);
    const j = await scoreChunkScenarios(input("—", dirs));
    expect(j.status).toBe("not-run");
    expect(j.reason).toContain("names no sealed scenario");
    expect(fake.scoreCalls).toHaveLength(0);
  });

  // Every chunk of label-check landed unscored this way (2026-11-23): a chunk
  // that names scenarios needs an app the judge can start, and that is the
  // builder's to fix.
  it("no launch file anywhere → counts against the chunk, saying what to write", async () => {
    const j = await scoreChunkScenarios(input("2", projectDirs()));
    expect(j.status).toBe("error");
    expect(j.reason).toContain("has no .lax-launch.json");
    expect(j.reason).toContain(`"ready_url"`);
    expect(fake.scoreCalls).toHaveLength(0);
  });

  it("a launch file with the wrong keys counts against the chunk, naming them", async () => {
    const dirs = projectDirs();
    writeFileSync(join(dirs.worktree, ".lax-launch.json"), JSON.stringify({ command: "node serve.mjs", port: 7070 }));
    const j = await scoreChunkScenarios(input("2", dirs));
    expect(j.status).toBe("error");
    expect(j.reason).toContain("(it has: command, port)");
  });

  it("finds the suite by the base project's name, runs the app in the worktree, on the worker's port", async () => {
    const dirs = projectDirs(); launch(dirs.base); // uncommitted spec: only in the base
    fake.scoreOutcome = { kind: "failures", reports: [report("02-checkout.md", 4), report("03-refund.md", 9)], failedReports: [] };
    const j = await scoreChunkScenarios(input("2, 3 (partial)", dirs, { workerIndex: 1 }));
    expect(fake.scoreCalls[0].projectDir).toBe(dirs.worktree);
    expect(fake.scoreCalls[0].workerIndex).toBe(1);
    expect(fake.scoreCalls[0].scenarioPaths.map(p => p.split(/[\\/]/).pop())).toEqual(["02-checkout.md", "03-refund.md"]);
    expect(j.status).toBe("scored");
    expect(j.scores).toEqual([
      { file: "02-checkout.md", score: 4, passed: false, reasoning: "judge saw 4", failedCriteria: ["order total shown"] },
      { file: "03-refund.md", score: 9, passed: true, reasoning: "judge saw 9", failedCriteria: [] },
    ]);
  });

  // "4 (partial)" on several chunks was judged after each, and the earlier
  // ones went back to their builders for work a later chunk was planned to do.
  it("a scenario several chunks name is judged at the last of them only", async () => {
    const dirs = projectDirs(); launch(dirs.base);
    const multi = parsePlanText([
      "# Plan", "## Phase A — Core",
      ...[[3, "2 (partial)"], [4, "2, 3"], [5, "3"]].map(([n, sc]) => [
        `### Chunk ${n} — Part`, "- **Class:** leaf", "- **Slice:** s", "- **Depends on:** —", `- **Scenarios:** ${sc}`, "- **Done when:** d",
      ].join("\n")),
    ].join("\n"));
    const [c3, c4] = multi.chunks;
    const early = await scoreChunkScenarios({ ...input("—", dirs), chunk: c3, allChunks: multi.chunks });
    expect(early).toMatchObject({ status: "not-run", reason: "chunk 3's scenarios are judged when the last chunk that names them lands" });
    fake.scoreOutcome = { kind: "proceed", reports: [report("02-checkout.md", 8)] };
    await scoreChunkScenarios({ ...input("—", dirs), chunk: c4, allChunks: multi.chunks });
    expect(fake.scoreCalls[0].scenarioPaths.map(p => p.split(/[\\/]/).pop())).toEqual(["02-checkout.md"]);
  });

  // A fix round spent on a busy port fixes nothing: the judge's own trouble
  // starting the app is recorded, never charged to the builder.
  it("the judge's own trouble starting the app is not held against the chunk", async () => {
    const dirs = projectDirs(); launch(dirs.worktree);
    fake.scoreOutcome = { kind: "error", reason: "dev server failed to start: something is already answering at http://localhost:5173", harness: true };
    const j = await scoreChunkScenarios(input("2", dirs));
    expect(j.status).toBe("not-run");
    expect(j.reason).toContain("not the app's fault");
  });

  it("an app that would not start counts against the chunk; a cancel does not", async () => {
    const dirs = projectDirs(); launch(dirs.worktree);
    fake.scoreOutcome = { kind: "error", reason: "dev server failed to start: EADDRINUSE" };
    expect((await scoreChunkScenarios(input("2", dirs))).status).toBe("error");
    const ac = new AbortController(); ac.abort();
    expect((await scoreChunkScenarios(input("2", dirs, { signal: ac.signal }))).status).toBe("not-run");
  });
});

describe("defaultChunkJudge", () => {
  it("runs the skeptic even when a scenario failed, so one retry carries both findings", async () => {
    const dirs = projectDirs(); launch(dirs.base);
    fake.scoreOutcome = { kind: "failures", reports: [report("02-checkout.md", 3)], failedReports: [] };
    fake.skeptic = { status: "broken", finding: "negative quantity accepted" };
    const j = await defaultChunkJudge(input("2", dirs));
    expect(fake.skepticCalls).toBe(1);
    expect(j.skeptic.status).toBe("broken");
  });

  it("a cancelled run does not start the skeptic", async () => {
    const ac = new AbortController(); ac.abort();
    const j = await defaultChunkJudge(input("—", projectDirs(), { signal: ac.signal }));
    expect(fake.skepticCalls).toBe(0);
    expect(j.skeptic.status).toBe("not-run");
  });
});

const judging = (over: Partial<ChunkJudging> = {}): ChunkJudging => ({
  scenarios: { status: "scored", reason: "", scores: [{ file: "02-checkout.md", score: 8, passed: true, reasoning: "ok", failedCriteria: [] }] },
  skeptic: { status: "holds", finding: "tried" },
  ...over,
});

describe("chunkJudgingFinding", () => {
  it("passing scenarios and a skeptic that failed to break it → green (null)", () => {
    expect(chunkJudgingFinding(4, judging())).toBeNull();
  });

  it("not-run parts are recorded, never held against the chunk", () => {
    expect(chunkJudgingFinding(4, judging({
      scenarios: { status: "not-run", reason: "no launch spec", scores: [] },
      skeptic: { status: "not-run", finding: "timed out" },
    }))).toBeNull();
  });

  // What the skeptic found beyond the chunk's contract is for the ledger: a
  // chunk it could not break is green however long that list is.
  it("a skeptic's follow-ups never hold the chunk back", () => {
    const skeptic = { status: "holds" as const, finding: "tried", followUps: ["a 300-character name overflows", "no midnight test"] };
    expect(chunkJudgingFinding(4, judging({ skeptic }))).toBeNull();
    expect(chunkJudgingSummary(judging({ skeptic }))).toBe(
      "scenarios 1/1 passed (02-checkout.md 8/10); skeptic: holds; 2 follow-up(s) beyond the chunk's contract, " +
      "for the ledger, not blocking: a 300-character name overflows | no midnight test",
    );
  });

  it("a failed scenario → push_back with what the judge saw", () => {
    const f = chunkJudgingFinding(4, judging({
      scenarios: { status: "scored", reason: "", scores: [{ file: "02-checkout.md", score: 4, passed: false, reasoning: "total missing", failedCriteria: ["order total shown"] }] },
    }))!;
    expect(f).toMatchObject({ gate: "chunk-scenarios", action: "push_back" });
    expect(f.reasoning).toContain("02-checkout.md: fail, 4/10. total missing Failed: order total shown.");
  });

  it("a broken skeptic → push_back with its finding in full; both findings when both fail", () => {
    const skeptic = { status: "broken" as const, finding: "negative quantity accepted at src/cart.ts:12" };
    expect(chunkJudgingFinding(4, judging({ skeptic }))).toMatchObject({ gate: "skeptic", action: "push_back" });
    const both = chunkJudgingFinding(4, judging({ skeptic, scenarios: { status: "error", reason: "app did not start", scores: [] } }))!;
    expect(both.gate).toBe("chunk-scenarios");
    expect(both.reasoning).toContain("app did not start");
    expect(both.reasoning).toContain("src/cart.ts:12");
  });
});

// "0 of 18 passed" once hid 15 judge crashes (label-check, 2026-11-24). A
// scenario the harness could not judge is not something a builder can fix.
describe("a scenario the judge could not judge", () => {
  const unjudged = { file: "03-refund.md", score: 0, passed: false, reasoning: "Scorer crashed", failedCriteria: [], unjudged: "judge returned unparseable response" };

  it("never sends the chunk back, and the summary says it is unverified", () => {
    const j = judging({ scenarios: { status: "scored", reason: "", scores: [{ file: "02-checkout.md", score: 8, passed: true, reasoning: "ok", failedCriteria: [] }, unjudged] } });
    expect(chunkJudgingFinding(4, j)).toBeNull();
    expect(chunkJudgingSummary(j)).toBe(
      "scenarios 1/1 passed (02-checkout.md 8/10); 1 could not be judged, so unverified (03-refund.md: judge returned unparseable response); skeptic: holds",
    );
  });

  it("a real failure beside it still goes back, naming only the failure", () => {
    const failed = { file: "02-checkout.md", score: 3, passed: false, reasoning: "total missing", failedCriteria: [] };
    const f = chunkJudgingFinding(4, judging({ scenarios: { status: "scored", reason: "", scores: [failed, unjudged] } }))!;
    expect(f.action).toBe("push_back");
    expect(f.reasoning).toContain("02-checkout.md");
    expect(f.reasoning).not.toContain("03-refund.md");
  });

  it("is carried from the scorer's report", async () => {
    const dirs = projectDirs(); launch(dirs.base);
    const crashed = { ...report("03-refund.md", 0), abortReason: "page.goto: net::ERR_CONNECTION_REFUSED" };
    fake.scoreOutcome = { kind: "unjudged", reports: [crashed], unjudgedReports: [crashed] };
    const j = await scoreChunkScenarios(input("3", dirs));
    expect(j.status).toBe("scored");
    expect(j.scores[0].unjudged).toBe("page.goto: net::ERR_CONNECTION_REFUSED");
  });
});

describe("chunkJudgingSummary", () => {
  it("names the scores and the skeptic, and says when nothing was verified", () => {
    expect(chunkJudgingSummary(judging())).toBe("scenarios 1/1 passed (02-checkout.md 8/10); skeptic: holds");
    expect(chunkJudgingSummary(judging({ skeptic: { status: "not-run", finding: "timed out" } }))).toContain("skeptic did not run (unverified)");
  });
});

describe("the judge stage in the chunk review", () => {
  const CLEAN = "STATUS: done\nDONE_WHEN: met\nCHANGED: src/cart.ts\nTESTS: 2/2\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: clean.";
  const BLOCKED = CLEAN.replace("STATUS: done", "STATUS: blocked").replace("DONE_WHEN: met", "DONE_WHEN: unmet");
  const noBuild = async () => null;

  function review(rawReport: string, judge: () => Promise<ChunkJudging>, opts: { hook?: () => Promise<{ specGap: string; reasoning: string } | null>; buildExec?: () => Promise<unknown> } = {}) {
    const p = plan("2");
    return runChunkReviewWithJudgment({
      chunk: p.chunks[0], allChunks: p.chunks, plan: p, rawReport, projectDir: "/proj",
      chunkJudge: { judge: vi.fn(judge), preSha: "abc", baseProjectDir: "/proj" },
    }, opts.hook, undefined, (opts.buildExec ?? noBuild) as never);
  }

  it("a failing judging turns proceed into push_back and is attached to the outcome", async () => {
    const j = judging({ skeptic: { status: "broken", finding: "double booking" } });
    const o = await review(CLEAN, async () => j);
    expect(o.action).toBe("push_back");
    expect(o.findings.at(-1)?.gate).toBe("skeptic");
    expect(o.judging).toEqual(j);
  });

  it("is never reached when the mechanical gates or the build already failed", async () => {
    const judge = vi.fn(async () => judging());
    const p = plan("2");
    const halted = await runChunkReviewWithJudgment({
      chunk: p.chunks[0], allChunks: p.chunks, plan: p, rawReport: BLOCKED, projectDir: "/proj",
      chunkJudge: { judge, preSha: "abc", baseProjectDir: "/proj" },
    }, undefined, undefined, noBuild);
    expect(halted.action).not.toBe("proceed");
    const buildFailed = await runChunkReviewWithJudgment({
      chunk: p.chunks[0], allChunks: p.chunks, plan: p, rawReport: CLEAN, projectDir: "/proj",
      chunkJudge: { judge, preSha: "abc", baseProjectDir: "/proj" },
    }, undefined, undefined, async () => ({ gate: "build-exec", action: "halt", reasoning: "npm test failed" }));
    expect(buildFailed.action).toBe("halt");
    expect(judge).not.toHaveBeenCalled();
  });

  it("a judge push_back outranks the spec-gap hook; a green judging still lets the hook amend", async () => {
    const hook = vi.fn(async () => ({ specGap: "state the currency", reasoning: "spec silent on currency" }));
    const failing = judging({ skeptic: { status: "broken", finding: "x" } });
    expect((await review(CLEAN, async () => failing, { hook })).action).toBe("push_back");
    expect(hook).not.toHaveBeenCalled();
    const amended = await review(CLEAN, async () => judging(), { hook });
    expect(amended.action).toBe("amend_spec");
    expect(amended.judging?.skeptic.status).toBe("holds");
  });

  it("a judge that throws fails open, recorded as unverified", async () => {
    const o = await review(CLEAN, async () => { throw new Error("playwright missing"); });
    expect(o.action).toBe("proceed");
    expect(o.judging?.skeptic).toEqual({ status: "not-run", finding: "the chunk judge crashed: playwright missing" });
  });

  // The build-and-test check failed open with no record: a crash in it read
  // the same as a build that passed.
  it("a build check that crashes fails open, and the chunk says it was not built or tested", async () => {
    const o = await review(CLEAN, async () => judging(), { buildExec: async () => { throw new Error("spawn EPERM"); } });
    expect(o.action).toBe("proceed");
    expect(o.unverified).toBe("the build-and-test check crashed, so the chunk's code was not built or tested: spawn EPERM");
  });

  it("a build check with nothing to run says so on the chunk", async () => {
    const o = await review(CLEAN, async () => judging(), {
      buildExec: async (input: { onUnverified?: (n: string) => void }) => { input.onUnverified?.("the project has no build or test script"); return null; },
    } as never);
    expect(o.unverified).toBe("the project has no build or test script");
    expect((await review(CLEAN, async () => judging())).unverified).toBeUndefined();
  });
});

describe("a chunk that closes a phase", () => {
  const CLEAN = "STATUS: done\nDONE_WHEN: met\nCHANGED: src/cart.ts\nTESTS: 2/2\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: clean.";
  const gated = parsePlanText([
    "# Plan",
    "## Phase A — Core",
    "### Chunk 4 — Checkout",
    "- **Class:** trunk → `/senior-engineer`",
    "- **Slice:** pay for the cart.",
    "- **Depends on:** —",
    "- **Scenarios:** 2",
    "- **Done when:** an order is recorded.",
    "",
    "## Phase verification gates",
    "- Phase A: scenarios 1-3 pass.",
  ].join("\n"));
  const review = (judge: () => Promise<ChunkJudging>) => runChunkReviewWithJudgment({
    chunk: gated.chunks[0], allChunks: gated.chunks, plan: gated, rawReport: CLEAN, projectDir: "/proj",
    chunkJudge: { judge: vi.fn(judge), preSha: "abc", baseProjectDir: "/proj" },
  }, undefined, undefined, async () => null);

  it("is still judged: a broken chunk goes back to its builder instead of pausing", async () => {
    const o = await review(async () => judging({ skeptic: { status: "broken", finding: "refund twice" } }));
    expect(o.action).toBe("push_back");
    expect(isPhaseGatePause(o)).toBe(false);
  });

  it("a green chunk then pauses at the phase's gate, with its judging attached", async () => {
    const o = await review(async () => judging());
    expect(o.action).toBe("halt");
    expect(isPhaseGatePause(o)).toBe(true);
    expect(o.findings.at(-1)?.gate).toBe("phase-gate");
    expect(o.judging?.skeptic.status).toBe("holds");
  });

  it("a real halt beside the phase gate is not a pause", () => {
    expect(isPhaseGatePause({ action: "halt", findings: [
      { gate: "phase-gate", action: "halt", reasoning: "gate" },
      { gate: "build-exec", action: "halt", reasoning: "npm test failed" },
    ] })).toBe(false);
  });
});
