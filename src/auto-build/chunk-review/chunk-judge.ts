/**
 * Judging one chunk before it counts as green — the /greenfield skill's rule
 * (references/autonomous.md, section 6): a chunk is green when its held-out
 * scenarios pass AND a skeptic shows no break of its contract (skeptic-bar.ts).
 *
 * A stage of the chunk review (chunk-review/index.ts runChunkReviewWithJudgment),
 * run after the mechanical gates and the build-exec gate have passed. Opt-in per
 * run through `LoopOptions.chunkJudge`, like the spec-gap judgment hook; the
 * build tools pass {@link defaultChunkJudge}.
 *
 *   - Scenarios: the chunk's own `Scenarios:` numbers, scored by the one scoring
 *     run (scenario-scorer/phase-gate-runner.ts scoreScenarioFiles, shared with
 *     the phase gate and holdout_judge). A chunk that names none, or a project
 *     with no sealed suite or no launch spec, is not scored, and says so.
 *   - Skeptic: chunk-review/skeptic.ts, run after scoring (both may start
 *     servers in the same tree) and run even when a scenario failed, so one
 *     retry carries both findings.
 *
 * A failing scenario, an app that would not start for scoring, or a BROKEN
 * skeptic is a push_back: the loop's fix rounds (loop/handle-push-back.ts)
 * hand the builder each finding until the chunk is green, a round changes
 * nothing, or the rounds run out. What the builder is told is what the
 * judge saw (score, reasoning, failed criteria), never a scenario's own steps.
 */

import { basename } from "node:path";
import { LAUNCH_SPEC_FILENAME, LAUNCH_SPEC_SHAPE, readLaunchSpec } from "../scenario-scorer/launch-spec.js";
import { scoreScenarioFiles, sealedScenarioFilesDueAt, sealedScenarioFilesFor } from "../scenario-scorer/phase-gate-runner.js";
import { runChunkSkeptic } from "./skeptic.js";
import { isUnjudged } from "../scenario-scorer/types.js";
import type { ChunkJudge, ChunkJudgeInput, ScenarioJudging } from "./chunk-verdict.js";

export async function scoreChunkScenarios(input: ChunkJudgeInput): Promise<ScenarioJudging> {
  const project = basename(input.baseProjectDir);
  const files = input.allChunks
    ? sealedScenarioFilesDueAt(project, input.chunk, input.allChunks)
    : sealedScenarioFilesFor(project, [input.chunk]);
  if (files.length === 0) {
    const named = sealedScenarioFilesFor(project, [input.chunk]).length > 0;
    const reason = named
      ? `chunk ${input.chunk.number}'s scenarios are judged when the last chunk that names them lands`
      : `chunk ${input.chunk.number} names no sealed scenario of ${project}`;
    return { status: "not-run", reason, scores: [] };
  }
  // The chunk names scenarios, so by now the judge must be able to start the
  // app: a missing or unusable launch file is the builder's to fix, not a
  // reason to land the chunk unscored (every chunk of label-check was).
  let read = readLaunchSpec(input.projectDir);
  if (read.kind === "absent") read = readLaunchSpec(input.baseProjectDir);
  if (read.kind === "absent") {
    return { status: "error", reason: `${project} has no ${LAUNCH_SPEC_FILENAME}, so the judge cannot start the app. Write it: ${LAUNCH_SPEC_SHAPE}.`, scores: [] };
  }
  if (read.kind === "invalid") return { status: "error", reason: read.reason, scores: [] };
  const launch = read.spec;

  input.onProgress?.(`scoring ${files.length} scenario(s) for chunk ${input.chunk.number}`);
  const outcome = await scoreScenarioFiles({
    projectDir: input.projectDir, launch, scenarioPaths: files,
    signal: input.signal, workerIndex: input.workerIndex, onProgress: input.onProgress,
  });
  if (outcome.kind === "error" || outcome.kind === "no-spec") {
    // A cancel is not the chunk's fault; anything else (the app would not
    // start, scoring broke) is shown evidence against it.
    if (input.signal?.aborted) return { status: "not-run", reason: "cancelled while scoring", scores: [] };
    return { status: "error", reason: outcome.reason, scores: [] };
  }
  return {
    status: "scored",
    reason: "",
    scores: outcome.reports.map(r => ({
      file: basename(r.scenarioPath), score: r.score, passed: r.passed,
      reasoning: r.reasoning, failedCriteria: r.failedCriteria,
      ...(isUnjudged(r) ? { unjudged: r.abortReason } : {}),
    })),
  };
}

export const defaultChunkJudge: ChunkJudge = async (input) => {
  const scenarios = await scoreChunkScenarios(input);
  if (input.signal?.aborted) {
    return { scenarios, skeptic: { status: "not-run", finding: "cancelled before the skeptic ran" } };
  }
  input.onProgress?.(`skeptic attacking chunk ${input.chunk.number}`);
  const skeptic = await runChunkSkeptic({
    chunk: input.chunk, rawReport: input.rawReport, preSha: input.preSha, projectDir: input.projectDir,
    signal: input.signal, parentSessionId: input.parentSessionId, parentOpId: input.parentOpId,
  });
  return { scenarios, skeptic };
};
