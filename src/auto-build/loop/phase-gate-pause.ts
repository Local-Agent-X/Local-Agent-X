/**
 * Phase verification gates on the parallel path.
 *
 * The chunk that closes a phase is reviewed, built and judged like any other;
 * its review then pauses at the phase's gate (chunk-review/index.ts
 * isPhaseGatePause). The serial loop scores the phase right there (run.ts).
 * In parallel the closing chunk is the last by NUMBER, not by time: a sibling
 * of the same phase may still be building in another worktree. So here the
 * paused chunk is merged like any accepted chunk, and the phase is scored on
 * the merged base once every chunk of it in this run has landed, through the
 * serial path's own scoring and recovery (loop-phase-gate.ts).
 */

import type { ParsedChunk } from "../plan-parser.js";
import { isPhaseGatePause, type ChunkReviewOutcome } from "../chunk-review/index.js";
import { attemptPhaseGateScoring } from "../loop-phase-gate.js";
import { appendHalt } from "../failure-recovery.js";
import type { EmitFn, LoopEvent, LoopOptions, LoopResult } from "./types.js";

export interface PhasePauseScope {
  opts: LoopOptions;
  totalChunks: number;
  emit: EmitFn;
  events: LoopEvent[];
  outcomes: LoopResult["outcomes"];
}

export type PhaseScoreResult = { kind: "ok" } | { kind: "halt"; result: LoopResult };

export interface PhasePauseTracker {
  /** A chunk merged into base; remember its phase if its review paused at the gate. */
  landed(chunk: ParsedChunk, outcome: ChunkReviewOutcome): void;
  /** Score every paused phase whose chunks in this run have all landed. */
  scoreFinished(scope: PhasePauseScope, chunksCommitted: number): Promise<PhaseScoreResult>;
}

/** `runChunks` is the run's window: a phase's chunks outside it are not
 *  waited for (an earlier run built them, or a later one will). */
export function createPhasePauseTracker(runChunks: ParsedChunk[]): PhasePauseTracker {
  const landedNumbers = new Set<number>();
  const paused = new Map<string, { chunk: ParsedChunk; reasoning: string }>();

  return {
    landed(chunk, outcome) {
      landedNumbers.add(chunk.number);
      if (isPhaseGatePause(outcome)) paused.set(chunk.phase, { chunk, reasoning: outcome.reasoning });
    },

    async scoreFinished(scope, chunksCommitted) {
      for (const [phase, { chunk, reasoning }] of [...paused]) {
        const inRun = runChunks.filter(c => c.phase === phase);
        if (!inRun.every(c => landedNumbers.has(c.number))) continue;
        paused.delete(phase);

        const rec = await attemptPhaseGateScoring(scope.opts, chunk, scope.emit, scope.totalChunks);
        if (rec.kind === "recovered") {
          const entry = scope.outcomes.find(o => o.chunkNumber === chunk.number);
          if (entry) entry.action = "proceed";
          scope.emit({ type: "review-result", chunkNumber: chunk.number, totalChunks: scope.totalChunks, message: `${phase}: phase-gate scoring passed on the merged base — continuing` });
          continue;
        }
        // No launch spec → the gate stays a manual one, as on the serial path.
        const reason = rec.kind === "halt-with-context" ? rec.reason : reasoning;
        scope.emit({ type: "halt", chunkNumber: chunk.number, totalChunks: scope.totalChunks, message: reason });
        appendHalt(scope.opts.projectDir, { chunk: chunk.number, gate: "phase-gate", reason: reason.slice(0, 200) });
        return {
          kind: "halt",
          result: { status: "halted", lastChunk: chunk.number, chunksCommitted, haltReason: reason, outcomes: scope.outcomes, events: scope.events },
        };
      }
      return { kind: "ok" };
    },
  };
}
