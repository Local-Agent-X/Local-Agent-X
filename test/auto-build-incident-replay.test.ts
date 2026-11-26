/**
 * The build engine's incidents, replayed through the whole engine with a
 * scripted build lead.
 *
 * Each case is a way a real build went wrong, in the shape it went wrong: a
 * chunk the review kept sending back, a lead that parked on something only the
 * owner had, an engine check that was itself wrong. The lead's answers are
 * scripted; everything after them is production: the fix rounds, the floors,
 * the set-aside ledger, the waves, real worktrees and merges in a throwaway git
 * repo. Only the chunk worker (runChunkOnce) is stubbed, as in
 * auto-build-parallel-engine-e2e.test.ts: it writes the chunk's file and
 * returns the review outcome the case scripts for that attempt.
 *
 * What a model answers is the other half, measured by eval/build-lead; this
 * pins what the engine does with each answer, so a change to one rule cannot
 * quietly undo the fix for another incident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type Finding = { gate: string; action: string; reasoning: string };
type Scripted = { action: "proceed" | "push_back"; reasoning: string; findings: Finding[] };

const script = vi.hoisted(() => ({
  /** Review outcomes per chunk, one per attempt; past the end, the chunk is green. */
  outcomes: new Map<number, Scripted[]>(),
  /** The lead's answers about each chunk's fix rounds, in order. */
  lead: new Map<number, unknown[]>(),
  /** The lead's answers to the build's other calls, in order. */
  buildCalls: [] as unknown[],
  builds: [] as number[],
  asked: [] as Array<{ chunk: number; final: boolean; repeated: boolean }>,
  buildCallKinds: [] as string[],
}));

vi.mock("../src/auto-build/loop/run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: { chunk: { number: number; footprint?: string[] }; projectDir: string }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { chunkReportOf } = await import("../src/auto-build/chunk-review/chunk-report.js");
    const n = opts.chunk.number;
    script.builds.push(n);
    const file = opts.chunk.footprint?.[0] ?? `f${n}.txt`;
    fs.writeFileSync(path.join(opts.projectDir, file), `${n}.attempt${script.builds.filter((b) => b === n).length}`);
    const next = script.outcomes.get(n)?.shift() ?? { action: "proceed", reasoning: "green", findings: [] };
    return { ...next, report: chunkReportOf({ status: "done", doneWhen: "met", note: "", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" }, [file]) };
  }),
  chunkProcessFailureOutcome: vi.fn(() => null),
}));
vi.mock("../src/auto-build/advisor/index.js", () => ({ consultAdvisor: vi.fn(async () => null) }));
vi.mock("../src/auto-build/advisor/lead-decisions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askLead: vi.fn(async (_ref: unknown, s: { chunk: { number: number }; final?: boolean; repeated: boolean }) => {
    script.asked.push({ chunk: s.chunk.number, final: Boolean(s.final), repeated: s.repeated });
    return script.lead.get(s.chunk.number)?.shift() ?? null;
  }),
  askLeadBuildCall: vi.fn(async (_ref: unknown, s: { kind: string }) => {
    script.buildCallKinds.push(s.kind);
    return script.buildCalls.shift() ?? null;
  }),
}));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { WORKTREE_BASE } = await import("../src/agency/worktree-core.js");
const { cleanupWorktree } = await import("../src/agency/worktree.js");
const { MAX_LEAD_ROUNDS } = await import("../src/auto-build/loop/lead-rounds.js");
const { owedChecks } = await import("../src/auto-build/failure-recovery.js");

/** A plan of chunks, each writing its own file, with the dependencies given. */
function plan(chunks: Array<[number, number[]]>): string {
  return ["# Replay plan", "## Phase A — Build", ...chunks.flatMap(([n, deps]) => [
    `### Chunk ${n} — Part ${n}`,
    "- **Class:** leaf → `/vibe-code`",
    `- **Slice:** create f${n}.txt.`,
    `- **Files:** f${n}.txt`,
    `- **Depends on:** ${deps.length ? deps.join(", ") : "—"}`,
    `- **Done when:** f${n}.txt exists.`,
  ])].join("\n");
}
/** label-check-sol's shape: 1 and 2 independent, then 3 → 4 → 5. */
const CHAIN = plan([[1, []], [2, []], [3, [1]], [4, [3]], [5, [4]]]);

const sentBack = (gate: string, reasoning: string): Scripted => ({ action: "push_back", reasoning, findings: [{ gate, action: "push_back", reasoning }] });
const lead = { projectDir: "", originSessionId: "chat-replay" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let projectDir: string;
function build(planText: string) {
  // The plan the build runs is the project's spec/plan.md, as in a real build.
  writeFileSync(join(projectDir, "spec", "plan.md"), planText);
  git(projectDir, "commit", "-qam", "the plan");
  return runBuildLoop({
    projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(planText), startingChunk: 1,
    maxConcurrentChunks: 2, buildLead: { ...lead, projectDir },
  });
}
const worktreeNames = () => Array.from({ length: 8 }, (_, i) => `autobuild-c${i + 1}`);

beforeEach(() => {
  process.env.LAX_BUILD_PREFLIGHT = "0";
  process.env.LAX_SANDBOX = "host";
  script.outcomes.clear(); script.lead.clear(); script.buildCalls = []; script.builds = []; script.asked = []; script.buildCallKinds = [];
  for (const name of worktreeNames()) { try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* not there */ } }
  projectDir = mkdtempSync(join(tmpdir(), "incident-replay-"));
  git(projectDir, "init", "-q", "-b", "main");
  git(projectDir, "config", "user.email", "replay@example.com");
  git(projectDir, "config", "user.name", "Replay");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "replay", version: "0.0.0", private: true }) + "\n");
  // Every project the engine builds has its spec folder; decisions are recorded there.
  mkdirSync(join(projectDir, "spec"));
  writeFileSync(join(projectDir, "spec", "plan.md"), "# Replay plan\n");
  git(projectDir, "add", "-A");
  git(projectDir, "commit", "-qm", "init");
});

afterEach(() => {
  delete process.env.LAX_BUILD_PREFLIGHT;
  delete process.env.LAX_SANDBOX;
  for (const name of worktreeNames()) {
    try { cleanupWorktree(name); } catch { /* not registered */ }
    try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* not there */ }
  }
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("build engine incidents, replayed", () => {
  // label-check-sol chunk 4 (2026-11-25): all that ran on the machine passed;
  // the live check needed a phone and a Firebase project only the owner had.
  // The lead parked and chunk 5 never started.
  it("a check only the owner can run: owed lands the chunk unverified and the chunks after it build", async () => {
    script.outcomes.set(4, [sentBack("skeptic", "spacing variants of listed names fall back to manual entry; live scan unverified: no device")]);
    script.lead.set(4, [{ action: "owed", reasoning: "the rest are follow-ups", owedCheck: "live scan on a Gemini Nano device with the owner's Firebase project", followUps: ["normalize internal spacing"] }]);
    const result = await build(CHAIN);
    expect(result.status).toBe("complete");
    expect(script.builds).toContain(5);
    const four = result.outcomes.find((o) => o.chunkNumber === 4)!;
    expect(four.outcome.owed?.map((o) => o.why).join()).toContain("owed to the owner: live scan");
    // On the build's ledger, where a restart and the finish report find it.
    expect(owedChecks(projectDir)).toContainEqual(expect.objectContaining({ chunk: 4, check: "owed by the build lead" }));
    expect(git(projectDir, "show", "HEAD:spec/build-state.md")).toContain("check owed to the owner");
  });

  // label-check-sol chunk 3 (2026-11-25): every round closed its finding and a
  // fresh skeptic found the next odd input; at the ceiling the engine set it
  // aside without asking, and chunks 4 and 5 never started.
  it("eight rounds of new odd inputs: the lead has the last word at the ceiling, and its accept lands the chunk", async () => {
    script.outcomes.set(3, Array.from({ length: MAX_LEAD_ROUNDS + 1 }, (_, i) => sentBack("skeptic", `odd input ${i}`)));
    script.lead.set(3, [
      ...Array.from({ length: MAX_LEAD_ROUNDS }, () => ({ action: "continue", reasoning: "real", instruction: "close it" })),
      { action: "accept", reasoning: "new kinds of input to a scoped rule", followUps: ["U+2028"] },
    ]);
    const result = await build(CHAIN);
    expect(result.status).toBe("complete");
    expect(script.builds.filter((b) => b === 3)).toHaveLength(MAX_LEAD_ROUNDS + 1);
    expect(script.asked.filter((a) => a.chunk === 3 && a.final)).toHaveLength(1);
    expect(script.builds).toEqual(expect.arrayContaining([4, 5]));
  });

  // label-check-sol chunk 1 (2026-11-25): a report-shape check rejected
  // launch-readiness items that named exact adb steps, round after round.
  it("an engine check that is wrong: overrule lands the chunk and puts the check on record", async () => {
    script.outcomes.set(1, [sentBack("launch-readiness", "LAUNCH_READINESS item lacks a concrete verify step")]);
    script.lead.set(1, [{ action: "overrule", reasoning: "the check misread it", evidence: "the item names adb install -r and the result to require" }]);
    const result = await build(CHAIN);
    expect(result.status).toBe("complete");
    expect(script.builds.filter((b) => b === 1)).toHaveLength(1);
    expect(git(projectDir, "show", "HEAD:spec/build-state.md")).toContain("Engine check overruled by the build lead (launch-readiness)");
  });

  it("a lead's accept never lands failing tests: the worker is sent back, and the chunk lands when green", async () => {
    script.outcomes.set(2, [sentBack("build-exec", "npm test exited 1")]);
    script.lead.set(2, [{ action: "accept", reasoning: "good enough" }]);
    const result = await build(CHAIN);
    expect(result.status).toBe("complete");
    expect(script.builds.filter((b) => b === 2)).toHaveLength(2);
  });

  // label-check-sol chunk 4 (2026-11-25): the native scan was done; the
  // label vocabulary was the next open-ended piece of work, round after round.
  it("split: the chunk lands on what it keeps, and the part it split off is built in the same run", async () => {
    script.outcomes.set(4, [sentBack("skeptic", "Vitamin D3 is not in the scan vocabulary")]);
    script.lead.set(4, [{ action: "split", reasoning: "the scan is done; the vocabulary is its own work", doneWhen: "a scan prefills listed names", parts: [{ title: "Scan vocabulary", doneWhen: "common label forms prefill" }] }]);
    const result = await build(CHAIN);
    expect(result.status, result.haltReason).toBe("complete");
    expect(script.builds.filter((b) => b === 4)).toHaveLength(2);
    expect(script.builds.indexOf(401)).toBeGreaterThan(script.builds.indexOf(5));
    expect(git(projectDir, "show", "HEAD:spec/plan.md")).toContain("### Chunk 401 — Scan vocabulary");
  });

  it("park sets the chunk aside on the owner's question; what does not depend on it still builds", async () => {
    script.outcomes.set(1, [sentBack("skeptic", "two spec lines contradict")]);
    script.lead.set(1, [{ action: "park", reasoning: "a product call", question: "Which wins, line 4 or line 12?" }]);
    const result = await build(CHAIN);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toContain("Which wins, line 4 or line 12?");
    expect(script.builds).toContain(2);
    expect(script.builds).not.toContain(3);
  });

  // Three set-aside chunks ended every build, whatever was left.
  it("at three set-aside chunks the lead says whether the rest is worth building", async () => {
    const six = plan([[1, []], [2, []], [3, []], [4, []], [5, []], [6, []]]);
    for (const n of [1, 2, 3]) {
      script.outcomes.set(n, [sentBack("skeptic", `chunk ${n} breaks`)]);
      script.lead.set(n, [{ action: "park", reasoning: "owner call", question: `chunk ${n}?` }]);
    }
    script.buildCalls = [{ action: "continue", reasoning: "5 and 6 are independent" }];
    const result = await build(six);
    expect(script.buildCallKinds).toEqual(["set-aside-cap"]);
    expect(script.builds).toEqual(expect.arrayContaining([5, 6]));
    expect(result.status).toBe("halted");
  });

  it("without the lead's word at the cap, the build stops there as it always did", async () => {
    const six = plan([[1, []], [2, []], [3, []], [4, []], [5, []], [6, []]]);
    for (const n of [1, 2, 3]) {
      script.outcomes.set(n, [sentBack("skeptic", `chunk ${n} breaks`)]);
      script.lead.set(n, [{ action: "park", reasoning: "owner call", question: `chunk ${n}?` }]);
    }
    await build(six);
    expect(script.builds).not.toContain(5);
  });
});
