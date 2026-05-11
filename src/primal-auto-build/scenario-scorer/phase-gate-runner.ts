/**
 * Phase-gate scoring runner — invoked by the build loop when a phase-gate
 * halt fires. Auto-scores the phase's scenarios via Playwright; if all
 * pass at threshold, returns "proceed" so the loop skips the halt. If
 * any fail, returns "halt-with-failures" carrying the failure list so
 * the loop can decide whether to auto-fix-push-back.
 *
 * Project contract: `.primal-launch.json` declares how to start the dev
 * server. Absent → runner returns "no-spec" and the loop halts normally
 * (manual scoring path, the design's original handoff point).
 *
 * Scenario-set discovery: the runner reads plan.md's "Phase verification
 * gates" section to determine WHICH scenarios this phase touches. Falls
 * back to "score every scenario in scenarios/" if the plan doesn't carry
 * an explicit scenario list per phase.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import { readLaunchSpec } from "./launch-spec.js";
import { launchApp } from "./app-launcher.js";
import { parseScenarioFile } from "./parser.js";
import { scoreScenario } from "./scorer.js";
import type { ScoreReport } from "./types.js";

export type PhaseGateRunnerOutcome =
  | { kind: "no-spec"; reason: string }
  | { kind: "proceed"; reports: ScoreReport[] }
  | { kind: "failures"; reports: ScoreReport[]; failedReports: ScoreReport[] }
  | { kind: "error"; reason: string };

export interface PhaseGateRunnerOptions {
  projectDir: string;
  plan: ParsedPlan;
  chunk: ParsedChunk; // the chunk that closed the phase
  threshold?: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export async function runPhaseGateScoring(opts: PhaseGateRunnerOptions): Promise<PhaseGateRunnerOutcome> {
  const launch = readLaunchSpec(opts.projectDir);
  if (!launch) {
    return { kind: "no-spec", reason: `no ${opts.projectDir}/.primal-launch.json — falling back to manual phase-gate scoring` };
  }

  const scenarioPaths = pickScenarioFiles(opts.projectDir, opts.plan, opts.chunk);
  if (scenarioPaths.length === 0) {
    return { kind: "no-spec", reason: "no scenarios/ files found to score" };
  }
  opts.onProgress?.(`scoring ${scenarioPaths.length} scenarios for ${opts.chunk.phase}`);

  let app: Awaited<ReturnType<typeof launchApp>> | null = null;
  try {
    opts.onProgress?.(`starting dev server: ${launch.start}`);
    app = await launchApp(opts.projectDir, launch, opts.signal);
    opts.onProgress?.(`dev server ready at ${launch.readyUrl}`);
  } catch (e) {
    return { kind: "error", reason: `dev server failed to start: ${(e as Error).message}` };
  }

  const reports: ScoreReport[] = [];
  try {
    for (const path of scenarioPaths) {
      if (opts.signal?.aborted) {
        return { kind: "error", reason: "aborted mid-scoring" };
      }
      const scenario = (() => {
        try { return parseScenarioFile(path); } catch (e) { opts.onProgress?.(`skip ${path}: ${(e as Error).message}`); return null; }
      })();
      if (!scenario) continue;
      opts.onProgress?.(`scoring ${scenario.title}…`);
      const report = await scoreScenario({
        scenario,
        projectDir: opts.projectDir,
        launch,
        threshold: opts.threshold,
        signal: opts.signal,
      });
      reports.push(report);
      opts.onProgress?.(`scored ${scenario.title}: ${report.score}/10 ${report.passed ? "PASS" : "FAIL"}`);
    }
  } finally {
    await app.stop();
  }

  const failed = reports.filter(r => !r.passed);
  if (failed.length === 0) return { kind: "proceed", reports };
  return { kind: "failures", reports, failedReports: failed };
}

/**
 * Decide which scenarios this phase covers. v0 heuristic:
 *   - Find chunks belonging to this phase
 *   - Collect each chunk's `scenarios` field (e.g. "1, 4 (partial)") →
 *     extract integers
 *   - Match scenario files in `scenarios/` whose filename starts with
 *     `NN-` for each integer
 *
 * Falls back to ALL files in scenarios/ if matching produces nothing.
 */
function pickScenarioFiles(projectDir: string, plan: ParsedPlan, chunk: ParsedChunk): string[] {
  const scenarioDir = join(projectDir, "scenarios");
  if (!existsSync(scenarioDir)) return [];
  const all = readdirSync(scenarioDir).filter(f => f.endsWith(".md")).sort();

  const phaseChunks = plan.chunks.filter(c => c.phase === chunk.phase);
  const phaseScenarioNumbers = new Set<number>();
  for (const c of phaseChunks) {
    const nums = (c.scenarios || "").match(/\d+/g);
    if (nums) for (const n of nums) phaseScenarioNumbers.add(Number(n));
  }

  const matched = all
    .filter(f => {
      const num = Number((f.match(/^(\d+)/) || [])[1]);
      return Number.isFinite(num) && phaseScenarioNumbers.has(num);
    })
    .map(f => join(scenarioDir, f));

  return matched.length > 0 ? matched : all.map(f => join(scenarioDir, f));
}
