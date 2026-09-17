import type { ToolEffect, ToolResult } from "../types.js";
import {
  completeSideEffect,
  markSideEffectAmbiguous,
  markSideEffectExecuting,
  noteSideEffectReturned,
  prepareSideEffect,
} from "./side-effect-journal.js";

export interface JournaledExecution {
  readonly replayed: boolean;
  run(execute: () => Promise<ToolResult>): Promise<ToolResult>;
  reconcile(error: unknown): ToolResult | null;
  complete(result: ToolResult): void;
}

/** Bind one tool attempt sequence to its durable operation journal entry. */
export function createJournaledExecution(input: {
  operationId?: string;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  effect: ToolEffect;
}): JournaledExecution {
  const decision = prepareSideEffect(input.operationId, input.toolCallId, input.tool, input.args, input.effect);
  let started = false;
  // reconcile() releases the claim and records the outcome as ambiguous; the
  // entry is then final. complete() afterwards used to look for the released
  // claim, throw "side-effect journal claim lost", and turn a bash that simply
  // timed out into "bash failed inside the harness" (2026-09-17).
  let reconciled = false;
  const replayed = decision.kind === "replay" || decision.kind === "blocked";
  return {
    replayed,
    async run(execute) {
      if (decision.kind === "replay" || decision.kind === "blocked") return decision.result;
      if (decision.kind === "execute") {
        markSideEffectExecuting(decision.entry);
        started = true;
      }
      const result = await execute();
      if (decision.kind === "execute") noteSideEffectReturned(decision.entry);
      return result;
    },
    reconcile(error) {
      if (decision.kind !== "execute" || !started || input.effect.class !== "non-idempotent") return null;
      reconciled = true;
      return markSideEffectAmbiguous(decision.entry, error instanceof Error ? error.message : String(error));
    },
    complete(result) {
      if (decision.kind === "execute" && !reconciled) completeSideEffect(decision.entry, result);
    },
  };
}
