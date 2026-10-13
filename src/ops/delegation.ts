/**
 * Delegation lineage for tasks one agent writes for another (agent_spawn,
 * op_submit). Such a task is the parent model's paraphrase of the user, so the
 * instruction ledger never mines it for bans; the child inherits the bans
 * recorded on the op that wrote it. Reading the paraphrase turned a release
 * worker's own "never read credentials" into a ban on reading its repo, and
 * dropped any real constraint the parent forgot to repeat.
 */
import { getOpLedger } from "../canonical-loop/public/plan-ledger.js";
import { readOp, isInteractiveHostOpType } from "./op-store.js";
import { listOpsForSession } from "./session-bridge.js";
import type { TaskDelegation } from "./types.js";

/**
 * The op delegating from `sessionId`: the trusted calling op the executor
 * stamps (`_operationId`) when there is one, else the session's live
 * interactive turn (chat_turn / voice_turn). Never a guess among other live
 * ops — a peer worker's bans are not the caller's.
 */
export function delegatingOpId(sessionId: string, callerOpId?: string): string | undefined {
  if (callerOpId) return callerOpId;
  if (!sessionId) return undefined;
  for (const id of listOpsForSession(sessionId)) {
    const op = readOp(id);
    if (op && (op.status === "running" || op.status === "pending") && isInteractiveHostOpType(op.type)) {
      return op.id;
    }
  }
  return undefined;
}

/** Snapshot the delegating op's recorded bans for the task it is writing. An
 *  unidentifiable delegator inherits nothing — the ledger fails open. */
export function delegationFrom(sessionId: string, callerOpId?: string): TaskDelegation {
  const parentOpId = delegatingOpId(sessionId, callerOpId);
  const ledger = parentOpId ? getOpLedger(parentOpId) : undefined;
  return {
    ...(parentOpId ? { parentOpId } : {}),
    inheritedConstraints: {
      prohibitions: [...(ledger?.prohibitions ?? [])],
      phrases: [...(ledger?.phrases ?? [])],
    },
  };
}
