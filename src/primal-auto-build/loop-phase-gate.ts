/**
 * Phase-gate auto-scoring + advisor-driven recovery — extracted from
 * loop.ts to keep that file under the 400-LOC ceiling.
 *
 * Called by loop.ts when a chunk-review halt fires the phase-gate gate.
 * Returns:
 *   - { kind: "recovered" } → loop overrides halt → proceed
 *   - { kind: "halt-with-context", reason } → loop halts with this reason
 *   - { kind: "no-spec" } → no .primal-launch.json; loop falls back to manual halt
 *
 * The recovery loop runs at most 2 attempts. The advisor decides each
 * attempt's action (try-fix-worker / amend-spec-additively / halt). When
 * the advisor is unavailable (no API key, timeout, parse fail), we fall
 * back to try-fix-worker — the existing pre-Day-3 behavior.
 */

import type { ParsedChunk } from "./plan-parser.js";
import type { LoopEvent, LoopOptions } from "./loop.js";
import { runPhaseGateScoring } from "./scenario-scorer/phase-gate-runner.js";
import { runAutoFixWorker } from "./scenario-scorer/auto-fix.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "./loop-effects.js";
import { consultAdvisor, type AdvisorRecommendation } from "./advisor/index.js";
import type { ScoreReport } from "./scenario-scorer/types.js";

export type RecoveryOutcome =
  | { kind: "recovered" }
  | { kind: "halt-with-context"; reason: string }
  | { kind: "no-spec" };

export async function attemptPhaseGateScoring(
  opts: LoopOptions,
  chunk: ParsedChunk,
  emit: (e: Omit<LoopEvent, "elapsedMs">) => void,
  totalChunks: number,
): Promise<RecoveryOutcome> {
  emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: "phase-gate hit — attempting auto-scoring" });

  const firstPass = await runPhaseGateScoring({
    projectDir: opts.projectDir,
    plan: opts.plan,
    chunk,
    signal: opts.signal,
    onProgress: (msg) => emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `[score] ${msg}` }),
  });

  if (firstPass.kind === "no-spec") return { kind: "no-spec" };
  if (firstPass.kind === "error") return { kind: "halt-with-context", reason: `phase-gate scoring errored: ${firstPass.reason}` };
  if (firstPass.kind === "proceed") return { kind: "recovered" };

  return await runAdvisorDrivenRecovery(opts, chunk, emit, totalChunks, firstPass.reports, firstPass.failedReports);
}

async function runAdvisorDrivenRecovery(
  opts: LoopOptions,
  chunk: ParsedChunk,
  emit: (e: Omit<LoopEvent, "elapsedMs">) => void,
  totalChunks: number,
  initialAllReports: ScoreReport[],
  initialFailedReports: ScoreReport[],
): Promise<RecoveryOutcome> {
  let allReports = initialAllReports;
  let failedReports = initialFailedReports;

  for (const attempt of [1, 2] as const) {
    emit({
      type: "push-back", chunkNumber: chunk.number, totalChunks,
      message: `phase-gate attempt ${attempt}: ${failedReports.length} scenario(s) failed — consulting advisor`,
      data: { failed: failedReports.map(r => ({ title: r.scenarioTitle, score: r.score })) },
    });

    const rec: AdvisorRecommendation | null = await consultAdvisor({
      kind: "phase-gate-scenario-failure",
      chunk, failedReports, passedReports: allReports.filter(r => r.passed),
      projectDir: opts.projectDir, attemptNumber: attempt,
    }, { signal: opts.signal });

    const action = rec?.action || "try-fix-worker"; // fallback when advisor unavailable

    emit({
      type: "review-result", chunkNumber: chunk.number, totalChunks,
      message: `advisor (attempt ${attempt}): ${action}${rec?.reasoning ? ` — ${rec.reasoning}` : " (no advisor available, falling back)"}`,
    });

    if (action === "halt") {
      return { kind: "halt-with-context", reason: rec?.haltReason || `advisor halted after attempt ${attempt}` };
    }

    if (action === "amend-spec-additively" && rec?.specAddition) {
      const amend = await applyAdditiveSpecAmendment(opts.projectDir, chunk, rec.specAddition);
      if (!amend.ok) {
        return { kind: "halt-with-context", reason: `additive-diff gate rejected advisor's spec amendment: ${amend.error}` };
      }
      const specCommit = await commitSpecAmendment(opts.projectDir, chunk);
      emit({
        type: "spec-amended", chunkNumber: chunk.number, totalChunks,
        message: `advisor amended spec additively${specCommit.committed ? ` (sha ${specCommit.sha.slice(0, 8)})` : ""}`,
        data: { reasoning: rec.reasoning },
      });
    } else {
      const fix = await runAutoFixWorker({
        projectDir: opts.projectDir, chunk,
        failedReports, allReports,
        signal: opts.signal,
        subprocessTimeoutMs: opts.subprocessTimeoutMs,
      });
      if (!fix.workerCompleted) {
        return { kind: "halt-with-context", reason: `fix worker did not complete on attempt ${attempt}: ${fix.error || "unknown"}` };
      }
      emit({
        type: "review-result", chunkNumber: chunk.number, totalChunks,
        message: `fix-worker landed${fix.fixSha ? ` (sha ${fix.fixSha.slice(0, 8)})` : ""}${rec?.fixWorkerHint ? ` with hint: ${rec.fixWorkerHint.slice(0, 80)}…` : ""}`,
      });
    }

    const nextPass = await runPhaseGateScoring({
      projectDir: opts.projectDir, plan: opts.plan, chunk,
      signal: opts.signal,
      onProgress: (msg) => emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `[score-${attempt + 1}] ${msg}` }),
    });
    if (nextPass.kind === "proceed") return { kind: "recovered" };
    if (nextPass.kind === "no-spec" || nextPass.kind === "error") {
      return { kind: "halt-with-context", reason: `scoring pivoted unexpectedly on attempt ${attempt + 1}: ${nextPass.kind === "error" ? nextPass.reason : "launch spec disappeared"}` };
    }
    allReports = nextPass.reports;
    failedReports = nextPass.failedReports;
  }

  const stillFailing = failedReports.map(r => `${r.scenarioTitle} (${r.score}/10)`).join("; ");
  return { kind: "halt-with-context", reason: `phase-gate: scenarios still failing after 2 recovery attempts. Failing: ${stillFailing}` };
}
