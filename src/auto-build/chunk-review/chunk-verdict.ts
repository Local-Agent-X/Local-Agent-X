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
import type { OwedCheck } from "../failure-recovery.js";

export interface ChunkJudgeInput {
  chunk: ParsedChunk;
  /** What the builder reported, in a few lines (chunk-report.ts renderChunkReport): the skeptic's claim under attack. */
  claim: string;
  /** HEAD before the chunk was built. */
  preSha: string;
  /** Every chunk of the plan: a scenario named by several is judged at the
   *  last of them. Absent, the chunk is judged on every scenario it names. */
  allChunks?: ParsedChunk[];
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
  /** Why the harness could not judge it, twice: no verdict either way, so it
   *  never counts against the chunk, and the summary says it is unverified. */
  unjudged?: string;
}

export interface ScenarioJudging {
  /** scored: the judge ran. error: the app would not start or scoring broke
   *  (counts against the chunk). not-run: nothing to score, with the reason. */
  status: "scored" | "error" | "not-run";
  reason: string;
  scores: ScenarioScore[];
  /** not-run because the judge could not run here, not because nothing was
   *  due: the scenarios are owed to the owner. */
  owed?: boolean;
}

/** A check that could not run on a chunk (failure-recovery.ts OwedCheck, before the chunk has landed). */
export type OwedOnChunk = Omit<OwedCheck, "chunk">;
export const BUILD_CHECK = "build and tests";
export const SKEPTIC_CHECK = "skeptic review";
export const SCENARIOS_CHECK = "held-out scenarios";
/** A build command this machine refuses, put on the owner's list by the lead:
 *  a check of the whole build, so the same refusal is not asked about again. */
export const refusedCommandCheck = (command: string): string => `refused: ${command}`;

/** What the judge could not do on a chunk it did not send back: owed, not passed. */
export function owedFromJudging(j: ChunkJudging): OwedOnChunk[] {
  const owed: OwedOnChunk[] = [];
  if (j.scenarios.status === "not-run" && j.scenarios.owed) owed.push({ check: SCENARIOS_CHECK, why: `its held-out scenarios were not judged: ${j.scenarios.reason}` });
  // A scoring run that came back with nothing is not a pass: "0/0 passed"
  // landed every chunk of two builds unjudged (2026-11-26).
  if (j.scenarios.status === "scored" && j.scenarios.scores.length === 0) owed.push({ check: SCENARIOS_CHECK, why: "the judge was run on its held-out scenarios and judged none of them" });
  const unjudged = j.scenarios.scores.filter((s) => s.unjudged);
  if (unjudged.length) owed.push({ check: SCENARIOS_CHECK, why: `${unjudged.length} held-out scenario(s) could not be judged: ${unjudged.map((s) => `${s.file}: ${s.unjudged}`).join("; ")}` });
  if (j.skeptic.status === "not-run") owed.push({ check: SKEPTIC_CHECK, why: `the skeptic did not review it: ${j.skeptic.finding}` });
  return owed;
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
 *  the skeptic's follow-ups never count).
 *
 *  An app the judge could not start is "chunk-unjudged", not a failed scenario:
 *  label-check-sol is a native Android app with no URL to drive, its last chunk
 *  was held as failing scenarios no judge could ever run, and the lead's "owed"
 *  was refused (2026-11-25). The finish checks and the wall probe already call
 *  that unjudged. */
export function chunkJudgingFinding(chunkNumber: number, j: ChunkJudging): GateFinding | null {
  const failed = j.scenarios.scores.filter(s => !s.passed && !s.unjudged);
  const scenariosAgainst = j.scenarios.status === "error" || failed.length > 0;
  const skepticAgainst = j.skeptic.status === "broken";
  if (!scenariosAgainst && !skepticAgainst) return null;

  const parts: string[] = [`Chunk ${chunkNumber} is not green yet.`];
  if (j.scenarios.status === "error") parts.push(`The app could not be scored: ${j.scenarios.reason}`);
  if (failed.length > 0) parts.push(`Held-out scenarios that failed (what the judge saw):\n${failed.map(scoreLine).join("\n")}`);
  if (skepticAgainst) parts.push(`The skeptic broke it:\n${j.skeptic.finding}`);
  return {
    gate: failed.length > 0 ? "chunk-scenarios" : j.scenarios.status === "error" ? "chunk-unjudged" : "skeptic",
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
  const unjudged = sc.scores.filter(s => s.unjudged);
  const judged = sc.scores.filter(s => !s.unjudged);
  const notJudged = unjudged.length
    ? `; ${unjudged.length} could not be judged, so unverified (${unjudged.map(s => `${s.file}: ${s.unjudged}`).join("; ")})`
    : "";
  const scenarios = sc.status === "scored"
    ? `scenarios ${judged.filter(s => s.passed).length}/${judged.length} passed (${judged.map(s => `${s.file} ${s.score}/10`).join(", ")})${notJudged}`
    : sc.status === "error" ? `scenarios could not be scored: ${sc.reason}` : `scenarios not scored: ${sc.reason}`;
  const skeptic = j.skeptic.status === "not-run" ? `skeptic did not run (unverified): ${j.skeptic.finding}` : `skeptic: ${j.skeptic.status}`;
  return `${scenarios}; ${skeptic}${followUpsNote(j.skeptic.followUps)}`;
}
