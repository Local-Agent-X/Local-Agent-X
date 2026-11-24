/**
 * What judging one chunk produced, and what that means for the chunk: the
 * record (scenario scores, the skeptic's verdict), the review finding it turns
 * into, and its one-line summary. Pure: the chunk review (index.ts) and the run
 * summary (orchestrator/manager.ts) read it without loading the judge that runs
 * agents and the app (chunk-judge.ts).
 */

import type { ParsedChunk } from "../plan-parser.js";
import type { SkepticVerdict } from "./skeptic.js";
import type { GateFinding } from "./gates.js";

export interface ChunkJudgeInput {
  chunk: ParsedChunk;
  /** The builder's final report, verbatim: the skeptic's claim under attack. */
  rawReport: string;
  /** HEAD before the chunk was built. */
  preSha: string;
  /** The tree the chunk was built in: its worktree on the parallel path. */
  projectDir: string;
  /** The project the build is for. Its folder name names the sealed suite (a
   *  worktree's would not), and its launch spec is the fallback when the
   *  worktree has none (an uncommitted `.lax-launch.json` stays in the base). */
  baseProjectDir: string;
  /** Concurrent-build slot: a distinct dev-server port per parallel chunk. */
  workerIndex?: number;
  signal?: AbortSignal;
  parentSessionId?: string;
  parentOpId?: string;
  onProgress?: (msg: string) => void;
}

export interface ScenarioScore {
  file: string;
  score: number;
  passed: boolean;
  reasoning: string;
  failedCriteria: string[];
}

export interface ScenarioJudging {
  /** scored: the judge ran. error: the app would not start or scoring broke
   *  (counts against the chunk). not-run: nothing to score, with the reason. */
  status: "scored" | "error" | "not-run";
  reason: string;
  scores: ScenarioScore[];
}

export interface ChunkJudging {
  scenarios: ScenarioJudging;
  skeptic: SkepticVerdict;
}

export type ChunkJudge = (input: ChunkJudgeInput) => Promise<ChunkJudging>;

function scoreLine(s: ScenarioScore): string {
  const failed = s.failedCriteria.length ? ` Failed: ${s.failedCriteria.join("; ")}.` : "";
  return `- ${s.file}: ${s.passed ? "pass" : "fail"}, ${s.score}/10. ${s.reasoning}${failed}`;
}

/** The review finding a judging produces: push_back when a scenario failed,
 *  the app would not start for scoring, or the skeptic broke the chunk; null
 *  when nothing counts against it (not-run parts are recorded, not held, and
 *  the skeptic's follow-ups never count). */
export function chunkJudgingFinding(chunkNumber: number, j: ChunkJudging): GateFinding | null {
  const failed = j.scenarios.scores.filter(s => !s.passed);
  const scenariosAgainst = j.scenarios.status === "error" || failed.length > 0;
  const skepticAgainst = j.skeptic.status === "broken";
  if (!scenariosAgainst && !skepticAgainst) return null;

  const parts: string[] = [`Chunk ${chunkNumber} is not green yet.`];
  if (j.scenarios.status === "error") parts.push(`The app could not be scored: ${j.scenarios.reason}`);
  if (failed.length > 0) parts.push(`Held-out scenarios that failed (what the judge saw):\n${failed.map(scoreLine).join("\n")}`);
  if (skepticAgainst) parts.push(`The skeptic broke it:\n${j.skeptic.finding}`);
  return {
    gate: scenariosAgainst ? "chunk-scenarios" : "skeptic",
    action: "push_back",
    reasoning: parts.join("\n\n"),
  };
}

/** What the skeptic found beyond the chunk's contract, for whoever keeps the
 *  ledger: listed with the verdict, and never a reason the chunk is not green. */
function followUpsNote(followUps: string[] | undefined): string {
  if (!followUps?.length) return "";
  const items = followUps.map((f) => f.replace(/\s+/g, " ").trim().slice(0, 300));
  return `; ${items.length} follow-up(s) beyond the chunk's contract, for the ledger, not blocking: ${items.join(" | ")}`;
}

/** One line for events and the run summary: the scores and the skeptic. */
export function chunkJudgingSummary(j: ChunkJudging): string {
  const sc = j.scenarios;
  const scenarios = sc.status === "scored"
    ? `scenarios ${sc.scores.filter(s => s.passed).length}/${sc.scores.length} passed (${sc.scores.map(s => `${s.file} ${s.score}/10`).join(", ")})`
    : sc.status === "error" ? `scenarios could not be scored: ${sc.reason}` : `scenarios not scored: ${sc.reason}`;
  const skeptic = j.skeptic.status === "not-run" ? `skeptic did not run (unverified): ${j.skeptic.finding}` : `skeptic: ${j.skeptic.status}`;
  return `${scenarios}; ${skeptic}${followUpsNote(j.skeptic.followUps)}`;
}
