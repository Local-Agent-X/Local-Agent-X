/**
 * The turn's commit row: everything driveTurn observed, mapped onto the
 * `CommitTurnInput` that checkpoint.ts writes atomically.
 *
 * Owns: the provider-state stamp (`viewCompacted`), redirect consumption,
 * timings, the replay trace, the learning receipt, and the two fields a
 * sticky directive contributes to the row — an abort's failure reason and a
 * strategy pivot's next-turn instruction.
 *
 * Does not own: the write (checkpoint.ts commitTurn), when it happens (the
 * conductor commits only after its last cancel check), the terminal decision
 * (decide-outcome.ts), or what a directive does once the row is durable
 * (apply-directive.ts). Pure: no I/O.
 */
import type { CommitTurnInput } from "../checkpoint.js";
import type { LeaseClaim } from "../lease.js";
import type { TurnInput } from "../adapter-contract.js";
import type { ProviderStateEnvelope, RedirectInstruction, ToolCallSummary } from "../types.js";
import type { Op } from "../../ops/types.js";
import type { DecideOutcomeResult } from "./decide-outcome.js";
import type { ModelCall } from "./model-call.js";
import type { MiddlewareDirective } from "./types.js";

/** What a turn that reached its commit has to say for itself. */
export interface CommittableTurn {
  op: Op;
  leaseClaim?: LeaseClaim;
  turnIdx: number;
  input: TurnInput;
  pendingRedirect: RedirectInstruction | null;
  call: ModelCall;
  toolSummary: ToolCallSummary[];
  toolDispatchMs: number;
  directive: MiddlewareDirective | null;
  outcome: Pick<DecideOutcomeResult, "terminalReason" | "allMessages" | "terminalOutcome">;
  learningSessionId: string | null;
}

export function commitTurnInput(turn: CommittableTurn): CommitTurnInput {
  const { call, directive, outcome, pendingRedirect } = turn;
  // Stamp the compacted-view marker from buildTurnInput onto the envelope
  // being committed — an EXPLICIT boolean on every turn, not just true on
  // compacted ones. The stamp doubles as an era marker: rows without the
  // boolean predate reliable recording (pre-stamp compactions, pre-2026-06-26
  // observedTools gaps) and lastTurnUsage refuses to anchor on them. Adapters
  // never set it; without the stamp the next turn would anchor context sizing
  // on usage that measured the compacted view against the full replay
  // (see ProviderStateEnvelope.viewCompacted).
  const providerState: ProviderStateEnvelope = {
    ...call.result.providerState,
    viewCompacted: turn.input.viewCompacted === true,
  };
  return {
    op: turn.op,
    leaseClaim: turn.leaseClaim,
    turnIdx: turn.turnIdx,
    providerState,
    messages: outcome.allMessages,
    toolCallSummary: turn.toolSummary,
    observedTools: call.observedTools,
    terminalReason: outcome.terminalReason,
    redirectConsumed: pendingRedirect != null,
    redirectInstructionId: pendingRedirect?.instructionId,
    redirectText: pendingRedirect?.text,
    modelMs: call.modelMs,
    toolDispatchMs: turn.toolDispatchMs,
    trace: call.result.trace,
    learnedOutcome: outcome.terminalOutcome ?? undefined,
    learningSessionId: turn.learningSessionId ?? undefined,
    // A middleware abort's note is the op's failure reason (commitTurn stamps it at the failed transition).
    failureReason: directive?.kind === "abort" ? (directive.message?.trim() || `Turn aborted by ${directive.firedBy}.`) : undefined,
    // A strategy pivot rides the durable row so a crash after commit cannot
    // lose the next-turn instruction; apply-directive.ts materializes it.
    nextTurnPivot: directive?.kind === "nudge" && directive.metadata?.strategyPivot
      ? { message: directive.message, firedBy: directive.firedBy, metadata: { strategyPivot: directive.metadata.strategyPivot } }
      : undefined,
  };
}
