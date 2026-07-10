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
  const replayed = decision.kind === "replay" || decision.kind === "reconcile";
  return {
    replayed,
    async run(execute) {
      if (decision.kind === "replay" || decision.kind === "reconcile") return decision.result;
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
      return markSideEffectAmbiguous(decision.entry, error instanceof Error ? error.message : String(error));
    },
    complete(result) {
      if (decision.kind === "execute") completeSideEffect(decision.entry, result);
    },
  };
}
