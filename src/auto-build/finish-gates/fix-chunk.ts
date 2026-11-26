/**
 * What makes a chunk a finish fix: one the finish gates wrote (run.ts) for what
 * the suite and the break-it agents found in the finished app, or a part the
 * build lead split off one. The skeptic checks such a chunk against what it was
 * given to fix, not the whole app (chunk-review/skeptic-bar.ts).
 */
import type { ParsedChunk } from "../plan-parser.js";

/** Fix chunks are numbered past any plan's, so their branches, set-aside
 *  records and events never collide with a plan chunk's. */
export const FIX_CHUNK_BASE = 1000;
export const FIX_CHUNK_PHASE = "Finish";
export const fixChunkTitle = (round: number, what: string): string => `Finish fix ${round}: ${what}`;

/** A split part's phase is its parent's heading (loop/split-chunks.ts):
 *  "Split from chunk 1012 — Finish fix 1: unlucky findings". */
const SPLIT_FROM_FIX = /^Split from chunk \d+ — Finish fix \d+:/;

export function isFinishFixChunk(chunk: Pick<ParsedChunk, "number" | "phase">): boolean {
  return (chunk.phase === FIX_CHUNK_PHASE && chunk.number > FIX_CHUNK_BASE) || SPLIT_FROM_FIX.test(chunk.phase);
}
