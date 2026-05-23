// Turn input assembly. Reads op_messages + the prior turn's providerState,
// and folds in any pending redirect snapshot taken before turn_started.
// Pure read — no writes, no events; the orchestrator owns ordering.

import type { TurnInput } from "../adapter-contract.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { RedirectInstruction } from "../types.js";
import type { Op } from "../../ops/types.js";
import { readLatestOpTurn, readOpMessages } from "../store.js";
import { getToolsForOp } from "../runtime.js";
import { readOp } from "../../ops/op-store.js";

export function buildTurnInput(
  op: Op,
  turnIdx: number,
  pendingRedirect: RedirectInstruction | null,
): TurnInput {
  const history = readOpMessages(op.id);
  const messages: CanonicalMessage[] = history.map(m => ({
    messageId: m.messageId,
    role: m.role,
    content: m.content,
    turnIdx: m.turnIdx,
    seqInTurn: m.seqInTurn,
    createdAt: m.createdAt,
  }));
  const prior = readLatestOpTurn(op.id);
  // Tools come from the per-op registry (chat-runner registers them on
  // submit; legacy worker-pool ops don't register and get []). Without
  // this, the adapter never tells the model about its tool surface and
  // tool-needing chats degrade to "I'm in planning mode" responses.
  const input: TurnInput = {
    opId: op.id,
    turnIdx,
    messages,
    providerState: prior?.providerState,
    tools: getToolsForOp(op.id),
  };
  if (pendingRedirect) input.pendingRedirect = pendingRedirect;
  return input;
}

export function readPendingRedirect(opId: string): RedirectInstruction | null {
  const fresh = readOp(opId);
  return fresh?.canonical?.redirectInstruction ?? null;
}
