/**
 * Scorer entry point — given a parsed scenario + a running app URL,
 * drive it via Playwright, judge the result, return a ScoreReport.
 *
 * Caller is responsible for starting the dev server (use app-launcher)
 * and stopping it after scoring. This separation means one launched
 * app can be scored against MANY scenarios without restarting it, which
 * is the typical phase-gate case (a whole phase of scenarios at once).
 */

import type { ScoreOptions, ScoreReport } from "./types.js";
import { driveScenario } from "./driver.js";
import { judgeScenario } from "./judge.js";

const DEFAULT_THRESHOLD = 7;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function scoreScenario(opts: ScoreOptions): Promise<ScoreReport> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const wallclock = new AbortController();
  const wallTimer = setTimeout(() => wallclock.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) wallclock.abort();
    else opts.signal.addEventListener("abort", () => wallclock.abort(), { once: true });
  }

  try {
    const trace = await driveScenario({
      scenario: opts.scenario,
      baseUrl: opts.launch.readyUrl,
      signal: wallclock.signal,
    });

    const verdict = await judgeScenario({
      scenario: opts.scenario,
      steps: trace.steps,
      finalUrl: trace.finalUrl,
    }, wallclock.signal);

    return {
      scenarioPath: opts.scenario.path,
      scenarioTitle: opts.scenario.title,
      score: verdict.score,
      passed: verdict.score >= threshold,
      steps: trace.steps,
      metCriteria: verdict.metCriteria,
      failedCriteria: verdict.failedCriteria,
      reasoning: verdict.reasoning,
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      scenarioPath: opts.scenario.path,
      scenarioTitle: opts.scenario.title,
      score: 0,
      passed: false,
      steps: [],
      metCriteria: [],
      failedCriteria: [],
      reasoning: `Scorer crashed before producing a verdict: ${(e as Error).message}`,
      durationMs: Date.now() - startedAt,
      abortReason: (e as Error).message,
    };
  } finally {
    clearTimeout(wallTimer);
  }
}
