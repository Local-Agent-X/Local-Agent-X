/**
 * What makes a chunk a finish fix: one the finish gates wrote (run.ts) for what
 * the suite and the break-it agents found in the finished app, or a part the
 * build lead split off one. The skeptic checks such a chunk against what it was
 * given to fix, not the whole app (chunk-review/skeptic-bar.ts).
 *
 * Also where a build's finish checks have got to (FinishProgress), kept in the
 * build's state file so a pause or a restart goes on from there instead of
 * starting the checks over.
 */
import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import { finishFixLeavesAppNoWorse } from "../chunk-review/skeptic-bar.js";
import { readBuildState } from "../failure-recovery.js";

/** Fix chunks are numbered past any plan's, so their branches, set-aside
 *  records and events never collide with a plan chunk's. */
export const FIX_CHUNK_BASE = 1000;
export const FIX_CHUNK_PHASE = "Finish";
/** Numbers each finish run of a build takes: 1000-1099, 1100-1199, ... */
const FIX_RUN_SPAN = 100;
export const fixChunkTitle = (round: number, what: string): string => `Finish fix ${round}: ${what}`;

/** A split part's phase is its parent's heading (loop/split-chunks.ts):
 *  "Split from chunk 1012 — Finish fix 1: unlucky findings". */
const SPLIT_FROM_FIX = /^Split from chunk (\d+) — Finish fix \d+:/;

export function isFinishFixChunk(chunk: Pick<ParsedChunk, "number" | "phase">): boolean {
  return (chunk.phase === FIX_CHUNK_PHASE && chunk.number > FIX_CHUNK_BASE) || SPLIT_FROM_FIX.test(chunk.phase);
}

/**
 * `text` with every mention of these finish fixes by number ("Chunk 1011
 * judged", "chunk 1011/5", "chunk 1011's") put by its title. Applied where the
 * build's text reaches the owner (the card's progress lines, the build's report
 * and summary), so a message written anywhere in the engine, now or later,
 * reads the same. Only the numbers of the fixes given are touched: a plan's
 * "chunk 7" stays.
 */
export function nameFinishFixes(text: string, fixes: readonly Pick<ParsedChunk, "number" | "title">[]): string {
  let out = text;
  for (const fix of fixes) {
    const asRegex = fix.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Where the title already follows the number, the number goes and the title stays once.
    out = out.replace(new RegExp(`\\b[Cc]hunk ${fix.number}(?:/\\d+)?(?:,|:)? "?${asRegex}"?`, "g"), () => fix.title);
    out = out.replace(new RegExp(`\\b[Cc]hunk ${fix.number}(?:/\\d+)?\\b`, "g"), () => fix.title);
  }
  return out;
}

/** The fix chunk a split part came from, or null for any other chunk. */
export function splitFromFix(chunk: Pick<ParsedChunk, "phase">): number | null {
  const m = chunk.phase.match(SPLIT_FROM_FIX);
  return m ? Number(m[1]) : null;
}

/**
 * Where a build's finish checks have got to: the round under way, the fix
 * chunks it wrote (they live in no plan file, so they are kept whole), the ones
 * that landed or were set aside, and what the rounds left open.
 */
export interface FinishProgress {
  round: number;
  /** The last round the checks may run (the lead can raise it). */
  fixRounds: number;
  /** Numbers past FIX_CHUNK_BASE this finish run's chunks take. */
  runBase: number;
  fixes: ParsedChunk[];
  /** Fix chunks that landed or were set aside this round. */
  done: number[];
  open: string[];
  /** When the finish checks stop starting new work (time-limit.ts). */
  deadline?: string;
}

/**
 * The numbers a new finish run starts from: past every fix chunk an earlier
 * run of this project set aside, whose kept branch and findings the next chunk
 * of that number would otherwise pick up (loop/carry-over.ts). A resumed
 * label-check-sol would have handed its set-aside fix 1012 to an unrelated new
 * fix 1012 (2026-11-25).
 */
export function nextFinishRunBase(projectDir: string): number {
  let base = 0;
  for (const key of Object.keys(readBuildState(projectDir).setAside ?? {})) {
    const n = Number(key);
    if (n > FIX_CHUNK_BASE && n < FIX_CHUNK_BASE * 10) base = Math.max(base, Math.floor((n - FIX_CHUNK_BASE) / FIX_RUN_SPAN) * FIX_RUN_SPAN + FIX_RUN_SPAN);
  }
  return base;
}

/** A fix chunk's number: its run's numbers, then its round, then its place. */
export function fixChunkNumber(runBase: number, round: number, place: number): number {
  return FIX_CHUNK_BASE + runBase + round * 10 + place;
}

/**
 * Whether a finish fix whose rounds are spent lands what it fixed: its build
 * and tests pass, and the one thing still holding it is the skeptic showing
 * the fix incomplete, never that it made the app worse. Setting it aside kept
 * every real fix it made off the app (label-check-sol's 1012, 2026-11-25).
 */
export function landsWhatItFixed(chunk: Pick<ParsedChunk, "number" | "phase">, outcome: ChunkReviewOutcome): boolean {
  if (!isFinishFixChunk(chunk)) return false;
  const holding = outcome.findings.filter((f) => f.action !== "proceed");
  return holding.length > 0 && holding.every((f) => f.gate === "skeptic") && finishFixLeavesAppNoWorse(outcome.judging?.skeptic.ground);
}
