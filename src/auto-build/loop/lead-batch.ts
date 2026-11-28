/**
 * The stop after each batch for a lead that drives the build from its turn
 * (advisor/lead-channel.ts): every chunk's report and review, passes included,
 * handed to the lead, and the next batch held until the lead calls build_next
 * again. A lead read only what went wrong before, each in a turn of its own.
 * With no lead attached nothing waits: the report is kept for when one is.
 */
import type { ParsedChunk } from "../plan-parser.js";
import type { LoopOptions, LoopResult } from "./types.js";
import { leadChatOf } from "../advisor/lead-chat.js";
import { leadCheckpoint } from "../advisor/lead-channel.js";
import { renderChunkReport } from "../chunk-review/chunk-report.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";

/** Changed files listed per chunk; the rest are counted. */
const FILES_SHOWN = 15;

function judgingLines(outcome: ChunkReviewOutcome): string[] {
  const j = outcome.judging;
  if (!j) return [];
  const s = j.scenarios;
  const scenarios = s.status === "scored"
    ? `${s.scores.filter((x) => x.passed).length}/${s.scores.length} held-out scenarios passed`
    : `held-out scenarios not run: ${s.reason}`;
  return [`Judged: ${scenarios}; skeptic ${j.skeptic.status}: ${j.skeptic.finding.replace(/\s+/g, " ").slice(0, 400)}`];
}

function chunkSection(chunk: ParsedChunk, totalChunks: number, outcome: ChunkReviewOutcome | undefined, landed: boolean): string {
  const head = `Chunk ${chunk.number}/${totalChunks}, "${chunk.title}": ${landed ? "landed" : "did not land"}.`;
  if (!outcome) return head;
  const files = outcome.report.changed;
  return [
    head,
    `Done when: ${chunk.doneWhen || "(none)"}`,
    `Review: ${outcome.reasoning}`,
    ...judgingLines(outcome),
    ...(outcome.owed?.length ? [`Not checked, owed to the owner: ${outcome.owed.map((o) => `${o.check} (${o.why})`).join("; ")}`] : []),
    `Files changed (${files.length}): ${files.slice(0, FILES_SHOWN).join(", ")}${files.length > FILES_SHOWN ? ", ..." : ""}`,
    `The worker's report:\n${renderChunkReport(outcome.report)}`,
  ].join("\n");
}

/** What the lead reads about a batch that has been built, reviewed and merged. */
export function landedBatchReport(batch: ParsedChunk[], totalChunks: number, outcomes: LoopResult["outcomes"], landed: readonly number[]): string {
  const sections = batch.map((chunk) => {
    const last = outcomes.filter((o) => o.chunkNumber === chunk.number).pop();
    return chunkSection(chunk, totalChunks, last?.outcome, landed.includes(chunk.number));
  });
  return [`Batch report: ${landed.filter((n) => batch.some((c) => c.number === n)).length} of ${batch.length} chunk(s) landed.`, ...sections].join("\n\n");
}

/** Hand the batch to the build's lead; with a lead attached, wait for it to go on. */
export async function stopForLead(
  opts: Pick<LoopOptions, "buildLead" | "signal">, batch: ParsedChunk[], totalChunks: number,
  outcomes: LoopResult["outcomes"], landed: readonly number[],
): Promise<void> {
  const sessionId = opts.buildLead && leadChatOf(opts.buildLead);
  if (!sessionId) return;
  await leadCheckpoint(sessionId, landedBatchReport(batch, totalChunks, outcomes, landed), { signal: opts.signal });
}
