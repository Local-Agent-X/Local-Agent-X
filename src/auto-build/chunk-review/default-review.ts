/**
 * The review a real build runs on every chunk beyond the mechanical gates: the
 * spec-gap judgment hook and the chunk judge (held-out scenarios + skeptic).
 * Named once so every way a build starts (run_build_plan's kickoff,
 * build_plan_resume, the orchestrator tools) judges chunks the same way.
 * Tests and other callers of runBuildLoop leave both out.
 */

import { defaultJudgmentHook } from "./judgment-hook.js";
import { defaultChunkJudge } from "./chunk-judge.js";

export const DEFAULT_CHUNK_REVIEW = {
  judgmentHook: defaultJudgmentHook,
  chunkJudge: defaultChunkJudge,
} as const;
