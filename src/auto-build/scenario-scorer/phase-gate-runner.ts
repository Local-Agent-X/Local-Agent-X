/**
 * Phase-gate scoring runner — invoked by the build loop when a phase-gate
 * halt fires. Auto-scores the phase's scenarios via Playwright; if all
 * pass at threshold, returns "proceed" so the loop skips the halt. If
 * any fail, returns "halt-with-failures" carrying the failure list so
 * the loop can decide whether to auto-fix-push-back.
 *
 * Project contract: `.lax-launch.json` declares how to start the dev
 * server. Absent → runner returns "no-spec" and the loop halts normally
 * (manual scoring path, the design's original handoff point).
 *
 * Scenario-set discovery: the runner reads plan.md's "Phase verification
 * gates" section to determine WHICH scenarios this phase touches. Falls
 * back to scoring the whole suite if the plan doesn't carry an explicit
 * scenario list per phase. The suite is the project's sealed held-out set
 * (src/holdout/), named by the project folder's name: this runner is harness
 * code, the one reader no tool call can be.
 */

import { basename, join } from "node:path";
import { listScenarios } from "../../holdout/store.js";
import { projectHoldoutDir } from "../../holdout/paths.js";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import { readLaunchSpec } from "./launch-spec.js";
import { launchApp, LaunchRefused } from "./app-launcher.js";
import { machineRefusalIn } from "../../tools/caged-failure-notice.js";
import { parseScenarioFile } from "./parser.js";
import { scoreScenario } from "./scorer.js";
import { isUnjudged, type ParsedScenario, type ProjectLaunchSpec, type ScoreReport } from "./types.js";

/** `failures` and `unjudged` keep the two apart: `failedReports` are verdicts
 *  against the app, `unjudgedReports` scenarios the harness could not judge
 *  even on a second try, which no builder can fix. */
export type PhaseGateRunnerOutcome =
  | { kind: "no-spec"; reason: string }
  | { kind: "proceed"; reports: ScoreReport[] }
  | { kind: "failures"; reports: ScoreReport[]; failedReports: ScoreReport[]; unjudgedReports: ScoreReport[] }
  | { kind: "unjudged"; reports: ScoreReport[]; unjudgedReports: ScoreReport[] }
  /** `harness`: the judge could not start the app for a reason outside it
   *  (its port already taken, the shell policy or the cage refusing the start
   *  line): not the app's failure, so never charged to its builder. */
  | { kind: "error"; reason: string; harness?: boolean };

export interface PhaseGateRunnerOptions {
  projectDir: string;
  plan: ParsedPlan;
  chunk: ParsedChunk; // the chunk that closed the phase
  threshold?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /**
   * Parallel-worker slot (Stage 2). Default 0 = serial single-build path,
   * unchanged. N>0 gives this worker a distinct dev-server port so parallel
   * chunk-gates don't collide on the launch spec's fixed port.
   */
  workerIndex?: number;
}

export async function runPhaseGateScoring(opts: PhaseGateRunnerOptions): Promise<PhaseGateRunnerOutcome> {
  const read = readLaunchSpec(opts.projectDir);
  if (read.kind === "absent") {
    return { kind: "no-spec", reason: `no ${opts.projectDir}/.lax-launch.json — falling back to manual phase-gate scoring` };
  }
  if (read.kind === "invalid") return { kind: "error", reason: read.reason };
  const launch = read.spec;

  const scenarioPaths = pickScenarioFiles(opts.projectDir, opts.plan, opts.chunk);
  if (scenarioPaths.length === 0) {
    return { kind: "no-spec", reason: `no sealed scenarios for ${basename(opts.projectDir)} to score` };
  }
  opts.onProgress?.(`scoring ${scenarioPaths.length} scenarios for ${opts.chunk.phase}`);
  return scoreScenarioFiles({ ...opts, launch, scenarioPaths });
}

export interface ScoreScenarioFilesOptions {
  projectDir: string;
  launch: ProjectLaunchSpec;
  scenarioPaths: string[];
  threshold?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  workerIndex?: number;
}

/**
 * A scenario file the judge cannot drive, as a report: unjudged, never a pass.
 * Such a file used to be skipped and counted nowhere, so a suite written as
 * prose paragraphs scored "0/0 passed" and every chunk of two builds landed
 * with no scenario run (label-check-grok, label-check-sol, 2026-11-26).
 */
function cannotDrive(path: string, why: string): ScoreReport {
  return {
    scenarioPath: path, scenarioTitle: basename(path), score: 0, passed: false, steps: [],
    metCriteria: [], failedCriteria: [], reasoning: "", durationMs: 0, abortReason: `cannot drive: ${why}`,
  };
}

type ReadScenario = { path: string; scenario: ParsedScenario } | { path: string; report: ScoreReport };

function readScenarios(paths: string[], onProgress?: (msg: string) => void): ReadScenario[] {
  return paths.map((path) => {
    try { return { path, scenario: parseScenarioFile(path) }; }
    catch (e) {
      onProgress?.(`cannot drive ${path}: ${(e as Error).message}`);
      return { path, report: cannotDrive(path, (e as Error).message) };
    }
  });
}

/** Start the app, score each scenario file against it, stop the app. The one
 *  scoring run: a phase gate's and the holdout_judge tool's. Every file given
 *  comes back as a report, and a run that judged nothing is never "proceed". */
export async function scoreScenarioFiles(opts: ScoreScenarioFilesOptions): Promise<PhaseGateRunnerOutcome> {
  const { launch } = opts;
  const read = readScenarios(opts.scenarioPaths, opts.onProgress);
  if (read.length === 0) return { kind: "no-spec", reason: "no scenario files were given to score" };
  // Nothing here can be driven: the app is not started for it.
  if (read.every((r) => "report" in r)) {
    const reports = read.flatMap((r) => ("report" in r ? [r.report] : []));
    return { kind: "unjudged", reports, unjudgedReports: reports };
  }

  let app: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    opts.onProgress?.(`starting dev server: ${launch.start}`);
    app = await launchApp(opts.projectDir, launch, opts.signal, opts.workerIndex ?? 0);
    opts.onProgress?.(`dev server ready at ${app.url}`);
  } catch (e) {
    const message = (e as Error).message;
    // The machine's or the judge's, not the app's: refused before it started,
    // or stopped by this machine as it started (what it printed says so).
    const harness = e instanceof LaunchRefused || machineRefusalIn(message) !== null;
    return { kind: "error", reason: `dev server failed to start: ${message}`, ...(harness ? { harness: true } : {}) };
  }

  // Score against the port the server was ACTUALLY pointed at. For worker 0
  // this is the same object (byte-identical serial path); a parallel worker
  // gets its allocated url so the driver navigates to the right server, never
  // the fixed base port another worker may hold.
  const scoringLaunch = app.url === launch.readyUrl ? launch : { ...launch, readyUrl: app.url };

  const reports: ScoreReport[] = [];
  // The app this run started stopped: that is the app failing, not the harness.
  const stopped = (): PhaseGateRunnerOutcome | null => app && app.proc.exitCode !== null
    ? { kind: "error", reason: `the app stopped running during scoring (exit code ${app.proc.exitCode}): ${app.stderr.slice(-3).join("").slice(0, 300)}` }
    : null;
  try {
    for (const item of read) {
      if (opts.signal?.aborted) {
        return { kind: "error", reason: "aborted mid-scoring" };
      }
      if ("report" in item) { reports.push(item.report); continue; }
      const { scenario } = item;
      const dead = stopped();
      if (dead) return dead;
      opts.onProgress?.(`scoring ${scenario.title}…`);
      const score = () => scoreScenario({
        scenario,
        projectDir: opts.projectDir,
        launch: scoringLaunch,
        threshold: opts.threshold,
        signal: opts.signal,
      });
      let report = await score();
      if (isUnjudged(report)) {
        const deadNow = stopped();
        if (deadNow) return deadNow;
        if (opts.signal?.aborted) return { kind: "error", reason: "aborted mid-scoring" };
        // One more try: a driver or judge hiccup is the harness's, and the
        // scenario gets a fresh run, told nothing about the first.
        opts.onProgress?.(`could not judge ${scenario.title} (${report.abortReason}); trying once more`);
        report = await score();
      }
      reports.push(report);
      opts.onProgress?.(`scored ${scenario.title}: ${isUnjudged(report) ? `COULD NOT JUDGE (${report.abortReason})` : `${report.score}/10 ${report.passed ? "PASS" : "FAIL"}`}`);
    }
  } finally {
    await app.stop();
  }

  const unjudged = reports.filter(isUnjudged);
  const failed = reports.filter(r => !r.passed && !isUnjudged(r));
  if (failed.length > 0) return { kind: "failures", reports, failedReports: failed, unjudgedReports: unjudged };
  if (unjudged.length > 0) return { kind: "unjudged", reports, unjudgedReports: unjudged };
  return { kind: "proceed", reports };
}

/**
 * Decide which scenarios this phase covers. v0 heuristic:
 *   - Find chunks belonging to this phase
 *   - Collect each chunk's `scenarios` field (e.g. "1, 4 (partial)") →
 *     extract integers
 *   - Match the project's sealed scenario files whose filename starts with
 *     `NN-` for each integer
 *
 * Falls back to the whole suite if matching produces nothing.
 */
function pickScenarioFiles(projectDir: string, plan: ParsedPlan, chunk: ParsedChunk): string[] {
  const project = basename(projectDir);
  const scenarioDir = projectHoldoutDir(project);
  if (!scenarioDir) return [];
  const matched = sealedScenarioFilesFor(project, plan.chunks.filter(c => c.phase === chunk.phase));
  return matched.length > 0 ? matched : listScenarios(project).map(f => join(scenarioDir, f));
}

/** The sealed scenario files the given chunks name in their `Scenarios:` field
 *  ("1, 4 (partial)" → files `01-…`, `04-…`), as absolute paths. Empty when the
 *  chunks name none, or the project has no sealed suite. The phase gate falls
 *  back to the whole suite on empty; a chunk's own judging does not. */
export function sealedScenarioFilesFor(project: string, chunks: ParsedChunk[]): string[] {
  return sealedScenarioFilesNumbered(project, scenarioNumbersOf(chunks));
}

/** The scenario numbers the given chunks' `Scenarios:` fields name. */
export function scenarioNumbersOf(chunks: ParsedChunk[]): Set<number> {
  const wanted = new Set<number>();
  for (const c of chunks) {
    const nums = (c.scenarios || "").match(/\d+/g);
    if (nums) for (const n of nums) wanted.add(Number(n));
  }
  return wanted;
}

/** The sealed scenario files a chunk is judged on: the ones it names that no
 *  later chunk of the plan names too. "4 (partial)" on three chunks was scored
 *  after each, and the first two went back to their builders for work the
 *  third was planned to do; a scenario is judged once the last chunk it
 *  needs has landed. */
export function sealedScenarioFilesDueAt(project: string, chunk: ParsedChunk, allChunks: ParsedChunk[]): string[] {
  const at = allChunks.findIndex((c) => c.number === chunk.number);
  const later = at < 0 ? new Set<number>() : scenarioNumbersOf(allChunks.slice(at + 1));
  const due = new Set([...scenarioNumbersOf([chunk])].filter((n) => !later.has(n)));
  return sealedScenarioFilesNumbered(project, due);
}

function sealedScenarioFilesNumbered(project: string, wanted: Set<number>): string[] {
  const scenarioDir = projectHoldoutDir(project);
  if (!scenarioDir) return [];
  if (wanted.size === 0) return [];
  return listScenarios(project)
    .filter(f => {
      const num = Number((f.match(/^(\d+)/) || [])[1]);
      return Number.isFinite(num) && wanted.has(num);
    })
    .map(f => join(scenarioDir, f));
}
