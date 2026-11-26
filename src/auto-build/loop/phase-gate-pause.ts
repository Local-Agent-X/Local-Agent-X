/**
 * A phase's verification gate when its chunks do not land in order.
 *
 * The chunk that closes a phase is reviewed, built and judged like any other;
 * its review then pauses at the phase's gate (chunk-review/index.ts
 * isPhaseGatePause). The serial loop scores the phase right there (run.ts).
 * In parallel the closing chunk is the last by NUMBER, not by time: a sibling
 * of the same phase may still be building in another worktree. So here the
 * paused chunk is merged like any accepted chunk, and the phase is scored on
 * the merged base once every chunk of it has landed, through the serial
 * path's own scoring and recovery (loop-phase-gate.ts).
 *
 * "Every chunk" can take more than one run: a chunk of the phase that was set
 * aside lands in a later one, which never builds the closing chunk again. So a
 * phase that lands its closing chunk unscored is put on record
 * (failure-recovery.ts owedPhaseGates), and whichever run lands the phase's
 * last missing chunk scores it. Both paths: the serial loop records a phase it
 * could not score for the same reason (run.ts).
 */

import type { ParsedChunk } from "../plan-parser.js";
import { isPhaseGatePause, type ChunkReviewOutcome } from "../chunk-review/index.js";
import { attemptPhaseGateScoring } from "../loop-phase-gate.js";
import { leavingTrackedFilesAsFound } from "../git-helpers.js";
import { appendHalt, clearOwedPhaseGate, owedPhaseGates, recordOwed, recordOwedPhaseGate } from "../failure-recovery.js";
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
  /** A chunk landed in the base. When its review paused at its phase's gate
   *  and the phase was not scored there (`scored` false, the default), the
   *  phase owes its gate from now on. */
  landed(chunk: ParsedChunk, outcome: ChunkReviewOutcome, scored?: boolean): void;
  /** Score every phase that owes its gate and whose chunks have all landed. */
  scoreFinished(scope: PhasePauseScope, chunksCommitted: number): Promise<PhaseScoreResult>;
}

export interface PhasePauseInput {
  projectDir: string;
  /** Every chunk of the plan: a phase is finished when all of its chunks landed. */
  planChunks: ParsedChunk[];
  /** Chunks that landed before this run: the ones before its window, and the
   *  ones inside it an earlier run landed past a chunk it set aside. */
  landedBefore: number[];
}

export function createPhasePauseTracker(input: PhasePauseInput): PhasePauseTracker {
  const { projectDir, planChunks } = input;
  const landedNumbers = new Set<number>(input.landedBefore);
  const paused = new Map<string, { chunk: ParsedChunk; reasoning: string }>();
  // Phases an earlier run left owing their gate.
  for (const [phase, owed] of Object.entries(owedPhaseGates(projectDir))) {
    const chunk = planChunks.find((c) => c.number === owed.chunk && c.phase === phase);
    if (chunk) paused.set(phase, { chunk, reasoning: owed.reasoning });
  }

  return {
    landed(chunk, outcome, scored = false) {
      landedNumbers.add(chunk.number);
      if (scored || !isPhaseGatePause(outcome)) return;
      paused.set(chunk.phase, { chunk, reasoning: outcome.reasoning });
      recordOwedPhaseGate(projectDir, chunk.phase, { chunk: chunk.number, reasoning: outcome.reasoning });
    },

    async scoreFinished(scope, chunksCommitted) {
      for (const [phase, { chunk, reasoning }] of [...paused]) {
        const ofPhase = planChunks.filter(c => c.phase === phase);
        if (!ofPhase.every(c => landedNumbers.has(c.number))) continue;
        paused.delete(phase);
        // The gate is reached now, whatever it says: scored, or left to a person.
        clearOwedPhaseGate(projectDir, phase);

        // Scored on the merged base: what its run rewrites there is put back
        // (git-helpers.ts leavingTrackedFilesAsFound), or the next merge is refused.
        const { value: rec } = await leavingTrackedFilesAsFound(projectDir, () => attemptPhaseGateScoring(scope.opts, chunk, scope.emit, scope.totalChunks));
        if (rec.kind === "recovered" || rec.kind === "unverified") {
          const entry = scope.outcomes.find(o => o.chunkNumber === chunk.number);
          if (entry) entry.action = "proceed";
          if (rec.kind === "unverified") recordOwed(projectDir, { check: `phase gate: ${phase}`, why: `${phase}'s scenarios were not judged at its gate: ${rec.reason}` });
          const said = rec.kind === "recovered" ? "phase-gate scoring passed on the merged base" : `phase gate unverified on the merged base: ${rec.reason}`;
          scope.emit({ type: "review-result", chunkNumber: chunk.number, totalChunks: scope.totalChunks, message: `${phase}: ${said} — continuing` });
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
