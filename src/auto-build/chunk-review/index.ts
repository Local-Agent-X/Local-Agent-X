/**
 * /chunk-review — runs the five gate checks against a just-completed
 * chunk and decides proceed / amend_spec / push_back / halt.
 *
 * Priority order: halt > push_back > amend_spec > proceed. The first
 * gate that fires with a stronger action wins; weaker findings are
 * recorded for the surfaced report but don't override.
 *
 * Inputs are intentionally explicit (parsed report, chunk metadata,
 * full plan, optional spec diff). This keeps the function pure and
 * testable without touching git or the filesystem. The loop (chunk 5)
 * is responsible for git operations and feeds the diff in.
 */

import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import { parseChunkReport, type ChunkReport } from "./report-parser.js";
import {
  gateReportShape,
  gateDoneWhen,
  gateAdditiveDiff,
  gatePhaseGate,
  gateLaunchReadiness,
  gateTestFailures,
  gateSpecGapJudgment,
  type GateFinding,
  type ReviewAction,
} from "./gates.js";
import type { JudgmentHook } from "./judgment-hook.js";

export interface ChunkReviewInput {
  /** The chunk we just ran. */
  chunk: ParsedChunk;
  /** All parsed chunks from the plan, in order. Needed for phase-gate detection. */
  allChunks: ParsedChunk[];
  /** The parsed plan (for phase-gates section, launch-readiness table). */
  plan: ParsedPlan;
  /** Raw report text from the subprocess's stdout. */
  rawReport: string;
  /**
   * Unified-diff text of any spec/ changes that landed since the chunk's
   * pre-state. Empty string when nothing changed. The loop runs
   * `git diff <pre-sha> -- spec/` and passes the output.
   */
  specDiff?: string;
}

export interface ChunkReviewOutcome {
  action: ReviewAction;
  /** Primary reasoning. Always set — defaults to "All gates passed." for proceed. */
  reasoning: string;
  /** Every gate finding that fired (including weaker ones not overriding). */
  findings: GateFinding[];
  /** Parsed report — surfaced so the loop can route launch-readiness items / log changes. */
  report: ChunkReport;
}

const ACTION_RANK: Record<ReviewAction, number> = {
  proceed: 0,
  amend_spec: 1,
  push_back: 2,
  halt: 3,
};

export function runChunkReview(input: ChunkReviewInput): ChunkReviewOutcome {
  const report = parseChunkReport(input.rawReport);

  const findings: GateFinding[] = [];
  const collect = (f: GateFinding | null) => { if (f) findings.push(f); };

  collect(gateReportShape(report));
  collect(gateDoneWhen(input.chunk, report));
  if (input.specDiff && input.specDiff.trim()) collect(gateAdditiveDiff(input.specDiff));
  collect(gatePhaseGate(input.chunk, input.plan, input.allChunks));
  collect(gateLaunchReadiness(report));
  collect(gateTestFailures(report));
  collect(gateSpecGapJudgment(report));

  if (findings.length === 0) {
    return { action: "proceed", reasoning: "All gates passed.", findings, report };
  }

  // Highest-rank action wins.
  let winner = findings[0];
  for (const f of findings) {
    if (ACTION_RANK[f.action] > ACTION_RANK[winner.action]) winner = f;
  }

  return { action: winner.action, reasoning: winner.reasoning, findings, report };
}

/**
 * Async variant that adds the LLM judgment hook on top of the
 * mechanical gates. The hook fires ONLY when the mechanical verdict is
 * "proceed" — it can elevate to "amend_spec" but never downgrades. This
 * preserves the mechanical-as-floor invariant: halts and push-backs
 * always trump the hook's opinion.
 *
 * When the hook returns a gap, we synthesize a SPEC_GAPS field into the
 * returned report so the loop's amend_spec path picks it up uniformly.
 * The loop doesn't need to know whether the gap came from the agent's
 * report or the hook.
 *
 * `projectDir` is required because the hook reads constitution +
 * CHANGED files from disk. Tests can pass a tmpdir.
 */
export async function runChunkReviewWithJudgment(
  input: ChunkReviewInput & { projectDir: string },
  hook?: JudgmentHook,
  signal?: AbortSignal,
): Promise<ChunkReviewOutcome> {
  const base = runChunkReview(input);
  if (!hook) return base;
  if (base.action !== "proceed") return base;

  let result;
  try {
    result = await hook({ chunk: input.chunk, report: base.report, projectDir: input.projectDir, signal });
  } catch {
    return base; // fail open
  }
  if (!result) return base;

  const reportWithGap: ChunkReport = { ...base.report, specGaps: result.specGap };
  const finding: GateFinding = {
    gate: "spec-gap-judgment",
    action: "amend_spec",
    reasoning: result.reasoning,
  };
  return {
    action: "amend_spec",
    reasoning: result.reasoning,
    findings: [...base.findings, finding],
    report: reportWithGap,
  };
}

export type { GateFinding, ReviewAction, ChunkReport };
export type { JudgmentHook, JudgmentResult, JudgmentHookInput } from "./judgment-hook.js";
