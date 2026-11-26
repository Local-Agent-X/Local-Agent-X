/**
 * Kill the build at every step, resume it, and check nothing was lost or
 * built twice.
 *
 * Every restart bug so far was met by a live build hours in: the finish checks
 * starting over, a part-built fix's files swallowed by the next chunk, a new
 * fix picking up an old one's branch, a landed chunk read as part-built
 * (label-check-sol, 2026-11-25). Each was a state the engine could be in when
 * it stopped that nothing had ever resumed from.
 *
 * Here a small plan (three chunks, then a finish round with one fix) runs
 * through the real loop, state reducer and resume, in a real git repo. Only
 * what a model would say is scripted. The run is recorded; then, for every
 * event in it:
 *   - hard kill: the project and the state exactly as they were at that event
 *     (a copy taken inside the event sink) are resumed;
 *   - pause: the run is stopped by its signal at that event, as Pause does,
 *     and resumed in place.
 * Each resume must end with every chunk on the project exactly once, the fix
 * landed once, a clean tree and nothing left set aside.
 *
 * The parallel path (two chunks at once, each in its own worktree) gets the
 * pause pass: a copy of the project cannot stand in for a hard kill there,
 * since its worktrees point back at the original. What a restart does with a
 * worktree a kill cut off is src/auto-build/loop/interrupted-chunk.test.ts.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

vi.hoisted(() => {
  // The loop's own environment probe has its suite; the cage's account cannot read a temp repo.
  process.env.LAX_BUILD_PREFLIGHT = "0";
  process.env.LAX_SANDBOX = "host";
});

/** How many times a scripted model has been asked: part of what makes two moments of a run differ. */
const script = vi.hoisted(() => ({ calls: 0 }));

const CLEAN = "STATUS: done\nDONE_WHEN: met\nCHANGED: src\nTESTS: n/a\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: done.";

// The scripted models: a worker writes its chunk's one file, the skeptic
// passes, and the "hostile" break-it agent finds one thing until the fix's
// file is on the project.
vi.mock("../src/auto-build/agents/chunk-runner.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    SKEPTIC_PROBE_DIR: ".skeptic",
    runChunkAgent: vi.fn(async (o: { role: string; title?: string; task: string; projectDir: string; signal?: AbortSignal }) => {
      const done = (stdout: string) => ({ stdout, exitCode: 0, durationMs: 1 });
      const title = o.title ?? "";
      script.calls++;
      // A stop cuts a running agent off (exit 130, as runChunkAgent reports an
      // abort); a worker it catches has written half of its file.
      if (o.signal?.aborted) {
        if (o.role !== "chunk-skeptic" && o.role !== "finish-breaker") {
          fs.mkdirSync(path.join(o.projectDir, "src"), { recursive: true });
          fs.writeFileSync(path.join(o.projectDir, "src", "half-written.txt"), "cut off mid-write\n");
        }
        return { stdout: "", exitCode: 130, durationMs: 1 };
      }
      if (o.role === "chunk-skeptic") return done("VERDICT: HOLDS\nFINDING: probed the edges.\nFOLLOW_UPS: none");
      if (o.role === "finish-breaker") {
        const fixed = fs.existsSync(path.join(o.projectDir, "src", "fix.txt"));
        return done(/hostile/.test(title) && !fixed ? "FINDINGS:\n- [high] the list drops its last item" : "FINDINGS: none");
      }
      const fix = /^Finish fix/.test(title);
      const n = Number(title.match(/Chunk (\d+)\//)?.[1] ?? o.task.match(/Chunk (\d+)/)?.[1]);
      fs.mkdirSync(path.join(o.projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(o.projectDir, "src", fix ? "fix.txt" : `c${n}.txt`), fix ? "fixed\n" : `chunk ${n}\n`);
      // A worker that goes on from a cut-off attempt finishes what that one left.
      fs.rmSync(path.join(o.projectDir, "src", "half-written.txt"), { force: true });
      return done(CLEAN);
    }),
  };
});
vi.mock("../src/auto-build/advisor/index.js", () => ({ consultAdvisor: vi.fn(async () => null) }));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { defaultChunkJudge } = await import("../src/auto-build/chunk-review/chunk-judge.js");
const state = await import("../src/auto-build/orchestrator/state.js");
const { readSavedRun } = await import("../src/auto-build/orchestrator/resume.js");
const { readBuildState } = await import("../src/auto-build/failure-recovery.js");
type OrchestratorState = import("../src/auto-build/orchestrator/state.js").OrchestratorState;
type LoopEvent = import("../src/auto-build/loop.js").LoopEvent;
type LoopOptions = import("../src/auto-build/loop.js").LoopOptions;

// Each chunk names the one file it writes: chunks with no declared files are
// built one at a time, whatever they wait on.
const chunk = (n: number, title: string, dependsOn: string) => [
  `### Chunk ${n} — ${title}`, "- **Class:** trunk → `/senior-engineer`", `- **Slice:** ${title.toLowerCase()}.`,
  `- **Files:** src/c${n}.txt`, `- **Depends on:** ${dependsOn}`, "- **Scenarios:** —", "- **Done when:** it works.", "",
];
const PLAN = ["# Plan", "", "## Phase A — App", "", ...chunk(1, "Skeleton", "—"), ...chunk(2, "List", "1"), ...chunk(3, "Detail", "2")].join("\n");
/** Chunks 2 and 3 wait only on 1, so they build side by side. */
const WIDE_PLAN = ["# Plan", "", "## Phase A — App", "", ...chunk(1, "Skeleton", "—"), ...chunk(2, "List", "1"), ...chunk(3, "Detail", "1")].join("\n");
const PLAN_CHUNKS = [1, 2, 3];
interface Shape { plan: string; maxConcurrentChunks?: number }
const SERIAL: Shape = { plan: PLAN };
const PARALLEL: Shape = { plan: WIDE_PLAN, maxConcurrentChunks: 2 };
const sh = (dir: string, cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function newProject(shape: Shape = SERIAL): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-kill-resume-"));
  sh(dir, "init -q -b main");
  sh(dir, "config user.email test@example.com");
  sh(dir, "config user.name Test");
  mkdirSync(join(dir, "spec"));
  writeFileSync(join(dir, "spec", "plan.md"), shape.plan);
  sh(dir, "add .");
  sh(dir, "commit -q -m init");
  return dir;
}

type RunArgs = Pick<LoopOptions, "startingChunk" | "maxChunks" | "landedChunks" | "finishProgress">;
interface Driven { events: LoopEvent[]; state: OrchestratorState; status: string }

/** Run the loop as the orchestrator does: every event and progress callback
 *  goes through the real state reducer, and `at` sees the state after each event. */
async function drive(dir: string, args: RunArgs, opts: { signal?: AbortSignal; at?: (k: number, s: OrchestratorState) => void; shape?: Shape } = {}): Promise<Driven> {
  const shape = opts.shape ?? SERIAL;
  const planPath = join(dir, "spec", "plan.md");
  const scope = state.runScopeOf(PLAN_CHUNKS, args.startingChunk, args.maxChunks);
  let s = state.makeInitial({
    opId: "op_kill", sessionId: "chat-kill", projectDir: dir, planPath, totalChunks: PLAN_CHUNKS.length,
    startingChunk: args.startingChunk, maxChunks: args.maxChunks, landedChunks: args.landedChunks, finish: args.finishProgress, planChunks: PLAN_CHUNKS,
  });
  const events: LoopEvent[] = [];
  const result = await runBuildLoop({
    projectDir: dir, planPath, plan: parsePlanText(shape.plan), ...args, finishGates: true, chunkJudge: defaultChunkJudge, signal: opts.signal,
    ...(shape.maxConcurrentChunks ? { maxConcurrentChunks: shape.maxConcurrentChunks } : {}),
    onEvent: (e) => { s = state.applyLoopEvent(s, e, scope); events.push(e); opts.at?.(events.length - 1, s); },
    onChunkInTree: (inTreeChunk) => { s = { ...s, inTreeChunk }; },
    onChunkSettled: (n) => { s = state.settleChunk(s, n); },
    onFinishProgress: (finish) => { s = { ...s, finish }; },
  });
  return { events, state: s, status: result.status };
}

const landed = (events: LoopEvent[]) => events.filter((e) => e.type === "chunk-landed").map((e) => e.chunkNumber);

/** Everything a resume can see at one moment of a run. Two events with the
 *  same picture resume the same way, so only the first of a run of them is
 *  tried: the same coverage in a third of the resumes. */
function picture(dir: string, s: OrchestratorState): string {
  const history = join(dir, ".lax-build-history.json");
  return [
    script.calls, sh(dir, "rev-parse HEAD"), sh(dir, "status --porcelain"), sh(dir, "branch --format=%(refname:short)@%(objectname:short)"),
    JSON.stringify({ ...s, updatedAt: "" }), existsSync(history) ? readFileSync(history, "utf-8").replace(/"at":\s*"[^"]*"/g, "") : "",
  ].join("\n--\n");
}

/** The events at which the picture changed from the event before. */
function distinctMoments(pictures: string[]): number[] {
  return pictures.map((p, k) => (k === 0 || p !== pictures[k - 1] ? k : -1)).filter((k) => k >= 0);
}

/** Resume `saved` in `dir` the way the app does, and check where it ends. */
async function resumeAndCheck(dir: string, saved: OrchestratorState, before: LoopEvent[], label: string, shape: Shape = SERIAL): Promise<void> {
  const at = { ...saved, projectDir: dir, planPath: join(dir, "spec", "plan.md") };
  const run = readSavedRun(at);
  expect(run.kind, `${label}: ${run.kind === "invalid" ? run.reason : ""}`).toBe("ready");
  if (run.kind !== "ready") return;
  const resumed = await drive(dir, run.run, { shape });
  expect(resumed.status, label).toBe("complete");
  const all = [...landed(before), ...landed(resumed.events)];
  // Every plan chunk landed exactly once across the run and its resume.
  expect(all.filter((n) => n < 1000).sort(), label).toEqual(PLAN_CHUNKS);
  // The one fix landed exactly once, whichever run built it.
  expect(all.filter((n) => n >= 1000), label).toHaveLength(1);
  expect(sh(dir, "status --porcelain"), label).toBe("");
  for (const file of ["c1.txt", "c2.txt", "c3.txt", "fix.txt"]) expect(existsSync(join(dir, "src", file)), `${label}: ${file}`).toBe(true);
  expect(sh(dir, "show HEAD:src/fix.txt"), label).toBe("fixed");
  expect(readBuildState(dir).setAside ?? {}, label).toEqual({});
}

describe("a build killed or paused at any step resumes to the same end", () => {
  let recorded: Driven;
  const snapshots: { dir: string; state: OrchestratorState }[] = [];
  const pictures: string[] = [];
  let moments: number[] = [];

  beforeAll(async () => {
    const dir = newProject();
    const snapRoot = mkdtempSync(join(tmpdir(), "lax-kill-snapshots-"));
    recorded = await drive(dir, { startingChunk: 1 }, {
      at: (k, s) => {
        const copy = join(snapRoot, String(k));
        cpSync(dir, copy, { recursive: true });
        snapshots.push({ dir: copy, state: structuredClone(s) });
        pictures.push(picture(dir, s));
      },
    });
    moments = distinctMoments(pictures);
  }, 300_000);

  it("the recorded run builds the three chunks and one finish fix", () => {
    expect(recorded.status).toBe("complete");
    expect(landed(recorded.events)).toEqual([1, 2, 3, 1011]);
    expect(snapshots.length).toBe(recorded.events.length);
    // Every landing and every chunk start is its own moment.
    for (const [k, e] of recorded.events.entries()) if (e.type === "chunk-landed" || e.type === "chunk-start") expect(moments).toContain(k);
  });

  it("a hard kill at every event", async () => {
    for (const k of moments) {
      const e = recorded.events[k];
      await resumeAndCheck(snapshots[k].dir, snapshots[k].state, recorded.events.slice(0, k + 1), `killed at event ${k} (${e.type}, chunk ${e.chunkNumber}: ${e.message.slice(0, 60)})`);
    }
  }, 900_000);

  it("a pause at every event", async () => {
    for (const k of moments) {
      const dir = newProject();
      const stop = new AbortController();
      const paused = await drive(dir, { startingChunk: 1 }, { signal: stop.signal, at: (i) => { if (i === k) stop.abort(); } });
      const e = recorded.events[k];
      await resumeAndCheck(dir, paused.state, paused.events, `paused at event ${k} (${e.type}, chunk ${e.chunkNumber}: ${e.message.slice(0, 60)})`);
      // A stop is not a failure: nothing goes on the halt history.
      expect(readBuildState(dir).haltHistory, `event ${k}`).toEqual([]);
    }
  }, 900_000);

  // A second stop in the finish checks used to drop their place: the first
  // resume landed no plan chunk, so its committed count stayed 0 and the
  // second resume no longer read the build as past its plan.
  it("a kill in the finish round, then another, still goes on with the round's fixes", async () => {
    const k = recorded.events.findIndex((e) => e.type === "chunk-start" && e.chunkNumber >= 1000);
    const dir = snapshots[k].dir + "-twice";
    cpSync(snapshots[k].dir, dir, { recursive: true });
    const first = readSavedRun({ ...snapshots[k].state, projectDir: dir, planPath: join(dir, "spec", "plan.md") });
    if (first.kind !== "ready") throw new Error(first.reason);
    let again: OrchestratorState | undefined;
    const stop = new AbortController();
    const second = await drive(dir, first.run, { signal: stop.signal, at: (_i, s) => { if (s.inTreeChunk && !again) { again = structuredClone(s); stop.abort(); } } });
    expect(again?.finish?.round).toBe(1);
    const judged = (events: LoopEvent[]) => events.filter((e) => /judging the whole sealed suite/.test(e.message)).length;
    const run = readSavedRun(again!);
    if (run.kind !== "ready") throw new Error(run.reason);
    expect(run.run.finishProgress?.round).toBe(1);
    const third = await drive(dir, run.run);
    // Round 1 was judged once, in the recorded run; the resumes only judge round 2.
    expect(judged(second.events)).toBe(0);
    expect(judged(third.events)).toBe(1);
    expect(readFileSync(join(dir, "src", "fix.txt"), "utf-8")).toBe("fixed\n");
  }, 300_000);
});

// Two chunks at once, each in its own worktree. A stop used to "set aside"
// both with the reason "agent aborted", which the next run carried into their
// briefs as a finding to keep fixed, and logged as a halt.
describe("a parallel build paused at any step resumes to the same end", () => {
  let recorded: Driven;
  let moments: number[] = [];

  beforeAll(async () => {
    const dir = newProject(PARALLEL);
    const pictures: string[] = [];
    recorded = await drive(dir, { startingChunk: 1 }, { shape: PARALLEL, at: (_k, s) => { pictures.push(picture(dir, s)); } });
    moments = distinctMoments(pictures);
  }, 300_000);

  it("the recorded run builds chunk 1, then 2 and 3 side by side, and one finish fix", () => {
    expect(recorded.status).toBe("complete");
    expect(landed(recorded.events).sort((a, b) => a - b)).toEqual([1, 2, 3, 1011]);
    // Side by side: chunk 3 starts before chunk 2 has landed.
    const at = (type: string, n: number) => recorded.events.findIndex((e) => e.type === type && e.chunkNumber === n);
    expect(at("chunk-start", 3)).toBeLessThan(at("chunk-landed", 2));
  });

  it("a pause at every event", async () => {
    for (const k of moments) {
      const dir = newProject(PARALLEL);
      const stop = new AbortController();
      const paused = await drive(dir, { startingChunk: 1 }, { shape: PARALLEL, signal: stop.signal, at: (i) => { if (i === k) stop.abort(); } });
      const e = recorded.events[k];
      await resumeAndCheck(dir, paused.state, paused.events, `paused at event ${k} (${e.type}, chunk ${e.chunkNumber}: ${e.message.slice(0, 60)})`, PARALLEL);
      // A stop is not a failure: nothing goes on the halt history.
      expect(readBuildState(dir).haltHistory, `event ${k}`).toEqual([]);
    }
  }, 900_000);
});
