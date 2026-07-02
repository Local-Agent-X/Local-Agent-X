import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import { appendHalt } from "../failure-recovery.js";
import { applyAdditiveSpecAmendment, commitChunk, commitSpecAmendment } from "../loop-effects.js";
import type { EmitFn, LoopEvent, LoopResult } from "./types.js";
import { haltedResult, safeGet } from "./types.js";

export interface HandleActionOptions {
  chunk: ParsedChunk;
  totalChunks: number;
  projectDir: string;
  finalAction: ReviewAction;
  finalOutcome: ChunkReviewOutcome;
  chunksCommitted: number;
  outcomes: LoopResult["outcomes"];
  events: LoopEvent[];
  emit: EmitFn;
}

export type HandleActionResult =
  | { kind: "halt"; result: LoopResult }
  | { kind: "advance"; chunksCommitted: number };

export async function handleAction(opts: HandleActionOptions): Promise<HandleActionResult> {
  const { chunk, totalChunks, projectDir, finalAction, finalOutcome, emit } = opts;
  let { chunksCommitted } = opts;

  switch (finalAction) {
    case "halt": {
      emit({ type: "halt", chunkNumber: chunk.number, totalChunks, message: finalOutcome.reasoning });
      const haltingFinding = finalOutcome.findings.find(f => f.action === "halt");
      appendHalt(projectDir, {
        chunk: chunk.number,
        gate: haltingFinding?.gate || "",
        reason: finalOutcome.reasoning.slice(0, 200),
      });
      return {
        kind: "halt",
        result: {
          status: "halted",
          lastChunk: chunk.number,
          chunksCommitted,
          haltReason: finalOutcome.reasoning,
          outcomes: opts.outcomes,
          events: opts.events,
        },
      };
    }

    case "proceed": {
      const commit = await safeGet(() => commitChunk(projectDir, chunk));
      if (!commit.ok) {
        return { kind: "halt", result: haltedResult(`commit failed for chunk ${chunk.number}: ${commit.error}`, chunk.number, opts.outcomes, opts.events) };
      }
      chunksCommitted++;
      emit({
        type: "commit", chunkNumber: chunk.number, totalChunks,
        message: `Committed: chunk ${chunk.number} ${commit.value.committed ? "(new sha " + commit.value.sha.slice(0, 8) + ")" : "(no changes to commit — review proceeded but tree was clean)"}`,
      });
      return { kind: "advance", chunksCommitted };
    }

    case "amend_spec": {
      const gaps = finalOutcome.report.specGaps;
      if (!gaps) {
        // Reviewer said amend_spec without supplying a SPEC_GAPS body —
        // that's a bug in the gate logic. Halt for safety.
        return { kind: "halt", result: haltedResult(`amend_spec returned but report.specGaps is empty — refusing to invent text`, chunk.number, opts.outcomes, opts.events) };
      }
      const amendResult = await applyAdditiveSpecAmendment(projectDir, chunk, gaps);
      if (!amendResult.ok) {
        return { kind: "halt", result: haltedResult(`spec amendment refused: ${amendResult.error}`, chunk.number, opts.outcomes, opts.events) };
      }
      emit({
        type: "spec-amended", chunkNumber: chunk.number, totalChunks,
        message: `Spec amended additively: ${amendResult.value.appendedTo}`,
        data: { appendedTo: amendResult.value.appendedTo, bytes: amendResult.value.bytesAppended },
      });
      // Commit the spec change first, then any chunk code changes.
      const specCommit = await safeGet(() => commitSpecAmendment(projectDir, chunk));
      if (!specCommit.ok) {
        return { kind: "halt", result: haltedResult(`commit of spec amendment failed for chunk ${chunk.number}: ${specCommit.error}`, chunk.number, opts.outcomes, opts.events) };
      }
      emit({ type: "commit", chunkNumber: chunk.number, totalChunks, message: `Committed: spec amendment for chunk ${chunk.number} (sha ${specCommit.value.sha.slice(0, 8)})` });
      const codeCommit = await safeGet(() => commitChunk(projectDir, chunk));
      if (!codeCommit.ok) {
        return { kind: "halt", result: haltedResult(`commit of chunk code failed for chunk ${chunk.number}: ${codeCommit.error}`, chunk.number, opts.outcomes, opts.events) };
      }
      chunksCommitted++;
      emit({ type: "commit", chunkNumber: chunk.number, totalChunks, message: `Committed: chunk ${chunk.number} code (sha ${codeCommit.value.sha.slice(0, 8)})` });
      return { kind: "advance", chunksCommitted };
    }

    case "push_back":
      // Already retried above; should not reach here. Defensive halt.
      return { kind: "halt", result: haltedResult(`unexpected push_back after retry for chunk ${chunk.number}`, chunk.number, opts.outcomes, opts.events) };
  }
}
