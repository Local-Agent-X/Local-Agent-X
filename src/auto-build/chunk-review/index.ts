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
import { runBuildExecGate, type BuildExecRunner } from "./gate-build-exec.js";
import { chunkJudgingFinding, type ChunkJudge, type ChunkJudgeInput, type ChunkJudging } from "./chunk-verdict.js";

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
  /** Judge the chunk against its held-out scenarios and a skeptic once the
   *  build-exec gate passes (chunk-judge.ts). Absent → no judging. */
  chunkJudge?: ChunkJudgeRun;
}

/** The judge and what it needs beyond the review's own input. */
export type ChunkJudgeRun = { judge: ChunkJudge } & Omit<ChunkJudgeInput, "chunk" | "rawReport" | "projectDir" | "signal">;

export interface ChunkReviewOutcome {
  action: ReviewAction;
  /** Primary reasoning. Always set — defaults to "All gates passed." for proceed. */
  reasoning: string;
  /** Every gate finding that fired (including weaker ones not overriding). */
  findings: GateFinding[];
  /** Parsed report — surfaced so the loop can route launch-readiness items / log changes. */
  report: ChunkReport;
  /** The project's structure check passed but listed what is nearing a size
   *  cap: carried into the next chunk's context, never a finding. */
  structureNote?: string;
  /** The chunk's scenario scores and the skeptic's verdict, when it was judged. */
  judging?: ChunkJudging;
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

  // Malformed/missing report short-circuits: the other gates would fire
  // spuriously on the empty fields (done-when "unmet", tests "missing")
  // and their halt would outrank the retry. The only meaningful verdict
  // here is "respawn once and demand the report block".
  const shapeFinding = gateReportShape(report);
  if (shapeFinding) {
    return { action: shapeFinding.action, reasoning: shapeFinding.reasoning, findings: [shapeFinding], report };
  }
  collect(gateDoneWhen(input.chunk, report));
  if (input.specDiff && input.specDiff.trim()) collect(gateAdditiveDiff(input.specDiff));
  collect(gatePhaseGate(input.chunk, input.plan, input.allChunks));
  collect(gateLaunchReadiness(report));
  collect(gateTestFailures(report));
  collect(gateSpecGapJudgment(report));

  return verdictFrom(findings, report);
}

/** The strongest finding decides; no findings is a proceed. */
function verdictFrom(findings: GateFinding[], report: ChunkReport): ChunkReviewOutcome {
  if (findings.length === 0) {
    return { action: "proceed", reasoning: "All gates passed.", findings, report };
  }
  let winner = findings[0];
  for (const f of findings) {
    if (ACTION_RANK[f.action] > ACTION_RANK[winner.action]) winner = f;
  }
  return { action: winner.action, reasoning: winner.reasoning, findings, report };
}

/** The outcome is a pause at a phase's verification gate after the chunk was
 *  accepted, not a halt on the chunk's own work: the loop scores the phase
 *  and goes on (serial: run.ts; parallel: loop/phase-gate-pause.ts). */
export function isPhaseGatePause(outcome: Pick<ChunkReviewOutcome, "action" | "findings">): boolean {
  const halts = outcome.findings.filter(f => f.action === "halt");
  return outcome.action === "halt" && halts.length > 0 && halts.every(f => f.gate === "phase-gate");
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
 *
 * Before the LLM hook, the build-execution gate runs the project's real
 * build/test command and headless-smokes the built artifact. It is the only
 * gate that OBSERVES behavior instead of trusting the agent's report — a
 * chunk that writes `STATUS: done` about a broken build (or a game that
 * renders a blank canvas) is caught here even though every string-based gate
 * passed it. It fires only when the mechanical verdict is already "proceed"
 * and can only elevate proceed → halt (never downgrades a real halt/push_back).
 * Injectable so tests stub the runner instead of spawning a build.
 */
export async function runChunkReviewWithJudgment(
  input: ChunkReviewInput & { projectDir: string },
  hook?: JudgmentHook,
  signal?: AbortSignal,
  buildExec: BuildExecRunner = runBuildExecGate,
): Promise<ChunkReviewOutcome> {
  const base = runChunkReview(input);
  const pause = base.findings.find(f => f.gate === "phase-gate");
  if (!pause) return reviewChunkWork(input, base, hook, signal, buildExec);
  // A chunk that closes a phase is still built, tested and judged like any
  // other; the phase's verification gate is a pause after it is accepted.
  const work = await reviewChunkWork(input, verdictFrom(base.findings.filter(f => f !== pause), base.report), hook, signal, buildExec);
  if (work.action !== "proceed" && work.action !== "amend_spec") return work;
  return { ...work, action: "halt", reasoning: pause.reasoning, findings: [...work.findings, pause] };
}

/** The build-exec gate, the chunk judge and the spec-gap hook, over the
 *  mechanical verdict on the chunk's own work. */
async function reviewChunkWork(
  input: ChunkReviewInput & { projectDir: string },
  base: ChunkReviewOutcome,
  hook: JudgmentHook | undefined,
  signal: AbortSignal | undefined,
  buildExec: BuildExecRunner,
): Promise<ChunkReviewOutcome> {
  if (base.action !== "proceed") return base;

  // Execution-grounded gate first: a build/test that actually FAILS, or an
  // artifact that loads blank, halts regardless of the LLM hook's opinion.
  let execFinding: GateFinding | null = null;
  let structureNote: string | undefined;
  try {
    execFinding = await buildExec({ projectDir: input.projectDir, signal, onStructureNote: (n) => { structureNote = n; } });
  } catch {
    execFinding = null; // fail open — a gate crash must not wedge the loop
  }
  if (execFinding) {
    return {
      action: execFinding.action,
      reasoning: execFinding.reasoning,
      findings: [...base.findings, execFinding],
      report: base.report,
    };
  }
  let passed: ChunkReviewOutcome = structureNote ? { ...base, structureNote } : base;

  // The chunk's held-out scenarios and the skeptic. Runs on a build that
  // actually built; a push_back here outranks the spec-gap hook's amend_spec.
  if (input.chunkJudge) {
    const judged = await judgeChunk(input, input.chunkJudge, passed, signal);
    if (judged.action !== "proceed") return judged;
    passed = judged;
  }

  if (!hook) return passed;

  let result;
  try {
    result = await hook({ chunk: input.chunk, report: base.report, projectDir: input.projectDir, signal });
  } catch {
    return passed; // fail open
  }
  if (!result) return passed;

  const reportWithGap: ChunkReport = { ...base.report, specGaps: result.specGap };
  const finding: GateFinding = {
    gate: "spec-gap-judgment",
    action: "amend_spec",
    reasoning: result.reasoning,
  };
  return {
    ...passed,
    action: "amend_spec",
    reasoning: result.reasoning,
    findings: [...passed.findings, finding],
    report: reportWithGap,
  };
}

/** Run the chunk judge and fold its verdict into the outcome. A judge that
 *  throws fails open (an infra crash must not wedge the build), recorded as
 *  unverified on the outcome rather than dropped. */
async function judgeChunk(
  input: ChunkReviewInput & { projectDir: string },
  run: ChunkJudgeRun,
  passed: ChunkReviewOutcome,
  signal?: AbortSignal,
): Promise<ChunkReviewOutcome> {
  const { judge, ...ctx } = run;
  let judging: ChunkJudging;
  try {
    judging = await judge({ ...ctx, chunk: input.chunk, rawReport: input.rawReport, projectDir: input.projectDir, signal });
  } catch (e) {
    const why = `the chunk judge crashed: ${(e as Error).message}`;
    judging = { scenarios: { status: "not-run", reason: why, scores: [] }, skeptic: { status: "not-run", finding: why } };
  }
  const finding = chunkJudgingFinding(input.chunk.number, judging);
  if (!finding) return { ...passed, judging };
  return { ...passed, action: finding.action, reasoning: finding.reasoning, findings: [...passed.findings, finding], judging };
}

export type { GateFinding, ReviewAction, ChunkReport };
export type { JudgmentHook, JudgmentResult, JudgmentHookInput } from "./judgment-hook.js";
