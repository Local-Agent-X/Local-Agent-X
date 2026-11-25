/**
 * Phase-gate auto-scoring + advisor-driven recovery — extracted from
 * loop.ts.
 *
 * Called by loop.ts when a chunk-review halt fires the phase-gate gate.
 * Returns:
 *   - { kind: "recovered" } → loop overrides halt → proceed
 *   - { kind: "halt-with-context", reason } → loop halts with this reason
 *   - { kind: "no-spec" } → no .lax-launch.json; loop falls back to manual halt
 *
 * The recovery loop runs at most 2 attempts. The advisor decides each
 * attempt's action (try-fix-worker / amend-spec-additively / halt). When
 * the advisor is unavailable (no API key, timeout, parse fail), we fall
 * back to try-fix-worker — the existing pre-Day-3 behavior.
 *
 * A build with a lead (advisor/lead-chat.ts) asks it instead, with up to
 * LEAD_ATTEMPTS attempts: "continue" sends a fix worker its instruction,
 * "park" stops at the phase on the owner's question. A failed scenario is
 * never landed past, so those are its only answers. An attempt the lead does
 * not answer is the advisor's, as above.
 */

import type { ParsedChunk } from "./plan-parser.js";
import type { LoopEvent, LoopOptions } from "./loop.js";
import { runPhaseGateScoring } from "./scenario-scorer/phase-gate-runner.js";
import { runAutoFixWorker } from "./scenario-scorer/auto-fix.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "./loop-effects.js";
import { consultAdvisor, type AdvisorRecommendation } from "./advisor/index.js";
import type { ScoreReport } from "./scenario-scorer/types.js";
import { askLeadBuildCall } from "./advisor/lead-decisions.js";

/** Recovery attempts a phase gets when the build's lead decides them. */
const LEAD_ATTEMPTS = 4;

/** What one recovery attempt does: a fix worker (with a hint), a spec amendment, or a halt. */
type AttemptPlan = { action: "fix"; hint?: string } | { action: "amend"; specAddition: string; reasoning?: string } | { action: "halt"; reason: string };

/** Ask the lead about this attempt; null when there is none or it did not answer. */
async function leadAttempt(
  opts: LoopOptions, chunk: ParsedChunk, totalChunks: number, attempt: number,
  failedReports: ScoreReport[], allReports: ScoreReport[],
): Promise<AttemptPlan | null> {
  if (!opts.buildLead) return null;
  const failing = failedReports.map((r) => `- ${r.scenarioTitle} (${r.score}/10): ${r.reasoning.replace(/\s+/g, " ").slice(0, 500)}` +
    (r.failedCriteria.length ? `\n  Failed criteria: ${r.failedCriteria.join("; ")}` : "")).join("\n");
  const passing = allReports.filter((r) => r.passed).map((r) => r.scenarioTitle).join(", ") || "none";
  const decision = await askLeadBuildCall(opts.buildLead, {
    kind: "phase-gate",
    title: `${chunk.phase}'s held-out scenarios fail on the merged base (attempt ${attempt} of ${LEAD_ATTEMPTS})`,
    evidence: `The phase closed with chunk ${chunk.number} (${chunk.title}), and the judge scored its scenarios on the merged base.\nFailing:\n${failing}\nPassing: ${passing}`,
    answers: {
      continue: "a fix worker gets your instruction with the failing scenarios' reports, then the phase is scored again",
      park: "stop the build at this phase on a question only the owner can answer (product, money, risk or taste)",
    },
    chunkNumber: chunk.number, totalChunks,
  }, { signal: opts.signal });
  if (!decision) return null;
  if (decision.action === "park") return { action: "halt", reason: `The build lead needs the owner to decide: ${decision.question}` };
  return { action: "fix", hint: decision.instruction };
}

/** The advisor's plan for this attempt (try-fix-worker when it is unavailable). */
async function advisorAttempt(
  opts: LoopOptions, chunk: ParsedChunk, attempt: number, failedReports: ScoreReport[], allReports: ScoreReport[],
): Promise<AttemptPlan & { said: string }> {
  const rec: AdvisorRecommendation | null = await consultAdvisor({
    kind: "phase-gate-scenario-failure",
    chunk, failedReports, passedReports: allReports.filter(r => r.passed),
    // The advisor knows two attempts; a later one (the lead did not answer) is its second.
    projectDir: opts.projectDir, attemptNumber: attempt === 1 ? 1 : 2,
  }, { signal: opts.signal });
  const action = rec?.action || "try-fix-worker"; // fallback when advisor unavailable
  const said = `advisor (attempt ${attempt}): ${action}${rec?.reasoning ? ` — ${rec.reasoning}` : " (no advisor available, falling back)"}`;
  if (action === "halt") return { action: "halt", reason: rec?.haltReason || `advisor halted after attempt ${attempt}`, said };
  if (action === "amend-spec-additively" && rec?.specAddition) return { action: "amend", specAddition: rec.specAddition, reasoning: rec.reasoning, said };
  return { action: "fix", hint: rec?.fixWorkerHint, said };
}

/** `unverified`: no scenario failed, but some could not be judged even on a
 *  second try. Nothing for a fix worker to do, and not a pass either: the run
 *  goes on and says so. */
export type RecoveryOutcome =
  | { kind: "recovered" }
  | { kind: "unverified"; reason: string }
  | { kind: "halt-with-context"; reason: string }
  | { kind: "no-spec" };

function unjudgedNote(reports: ScoreReport[]): string {
  return `${reports.length} scenario(s) could not be judged: ${reports.map(r => `${r.scenarioTitle} (${r.abortReason})`).join("; ")}`;
}

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
  if (firstPass.kind === "unjudged") return { kind: "unverified", reason: unjudgedNote(firstPass.unjudgedReports) };

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

  const attempts = opts.buildLead ? LEAD_ATTEMPTS : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    emit({
      type: "push-back", chunkNumber: chunk.number, totalChunks,
      message: `phase-gate attempt ${attempt}: ${failedReports.length} scenario(s) failed — asking ${opts.buildLead ? "the build lead" : "the advisor"}`,
      data: { failed: failedReports.map(r => ({ title: r.scenarioTitle, score: r.score })) },
    });

    const byLead = await leadAttempt(opts, chunk, totalChunks, attempt, failedReports, allReports);
    const plan: AttemptPlan = byLead ?? await advisorAttempt(opts, chunk, attempt, failedReports, allReports);
    const said = byLead
      ? `build lead (attempt ${attempt}): ${plan.action === "halt" ? "park" : "fix"}`
      : (plan as AttemptPlan & { said: string }).said;
    emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: said });

    if (plan.action === "halt") return { kind: "halt-with-context", reason: plan.reason };

    if (plan.action === "amend") {
      const amend = await applyAdditiveSpecAmendment(opts.projectDir, chunk, plan.specAddition);
      if (!amend.ok) {
        return { kind: "halt-with-context", reason: `additive-diff gate rejected advisor's spec amendment: ${amend.error}` };
      }
      const specCommit = await commitSpecAmendment(opts.projectDir, chunk);
      emit({
        type: "spec-amended", chunkNumber: chunk.number, totalChunks,
        message: `advisor amended spec additively${specCommit.committed ? ` (sha ${specCommit.sha.slice(0, 8)})` : ""}`,
        data: { reasoning: plan.reasoning },
      });
    } else {
      const fix = await runAutoFixWorker({
        projectDir: opts.projectDir, chunk,
        failedReports, allReports,
        signal: opts.signal,
        subprocessTimeoutMs: opts.subprocessTimeoutMs,
        // Same lineage every other orchestrator worker carries: the chat
        // session for sidebar attribution, the orchestrator op id so the
        // fix worker is an orchestrator CHILD — its report is consumed by
        // the re-score below, never injected into the user's chat.
        parentSessionId: opts.parentSessionId,
        parentOpId: opts.parentOpId,
        ...(plan.hint ? { hint: plan.hint } : {}),
      });
      if (!fix.workerCompleted) {
        return { kind: "halt-with-context", reason: `fix worker did not complete on attempt ${attempt}: ${fix.error || "unknown"}` };
      }
      emit({
        type: "review-result", chunkNumber: chunk.number, totalChunks,
        message: `fix-worker landed${fix.fixSha ? ` (sha ${fix.fixSha.slice(0, 8)})` : ""}${plan.hint ? ` with hint: ${plan.hint.slice(0, 80)}…` : ""}`,
      });
    }

    const nextPass = await runPhaseGateScoring({
      projectDir: opts.projectDir, plan: opts.plan, chunk,
      signal: opts.signal,
      onProgress: (msg) => emit({ type: "review-result", chunkNumber: chunk.number, totalChunks, message: `[score-${attempt + 1}] ${msg}` }),
    });
    if (nextPass.kind === "proceed") return { kind: "recovered" };
    if (nextPass.kind === "unjudged") return { kind: "unverified", reason: unjudgedNote(nextPass.unjudgedReports) };
    if (nextPass.kind === "no-spec" || nextPass.kind === "error") {
      return { kind: "halt-with-context", reason: `scoring pivoted unexpectedly on attempt ${attempt + 1}: ${nextPass.kind === "error" ? nextPass.reason : "launch spec disappeared"}` };
    }
    allReports = nextPass.reports;
    failedReports = nextPass.failedReports;
  }

  const stillFailing = failedReports.map(r => `${r.scenarioTitle} (${r.score}/10)`).join("; ");
  return { kind: "halt-with-context", reason: `phase-gate: scenarios still failing after ${attempts} recovery attempts. Failing: ${stillFailing}` };
}
