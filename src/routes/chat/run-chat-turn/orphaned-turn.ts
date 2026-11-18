/**
 * A chat turn whose server stopped under it still reaches its chat.
 *
 * A chat is written to disk when its turn ends (persistTurnState, called by
 * runCanonicalChat). A restart or crash kills that caller with the process, so
 * the turn's work, committed turn by turn to its op, never reached the chat: a
 * phone chat cut off on its first turn left no chat at all, and the phone's list
 * lost it (2026-11-18). On restart the op is recovered and ends (resumed and
 * done, or failed); when no live request in this process owns it, its committed
 * rows are folded into the chat here, through the same persistTurnState, with
 * the interrupted boundary when it did not finish.
 */
import type { ServerContext } from "../../../server-context.js";
import type { Op } from "../../../ops/types.js";
import { registerTerminalObserver } from "../../../canonical-loop/index.js";
import { OP_TYPE } from "../../../ops/op-types.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("routes.chat.orphaned-turn");

/** Chat-turn ops a live runCanonicalChat in this process will save itself. */
const owned = new Set<string>();

export function claimChatTurn(opId: string): void { owned.add(opId); }
export function releaseChatTurn(opId: string): void { owned.delete(opId); }

/** Whether the chat already holds this op's rows (saved before, or by its owner). */
async function alreadySaved(op: Op, ctx: ServerContext): Promise<boolean> {
  const { readOpMessages } = await import("../../../canonical-loop/index.js");
  const { messageProvenance } = await import("../../../memory/session-message-provenance.js");
  const ids = new Set(readOpMessages(op.id).filter((r) => !r.messageId.startsWith("hist-")).map((r) => r.messageId));
  if (ids.size === 0) return true; // nothing was committed: nothing to save
  const session = ctx.getOrCreateSession(op.sessionId!);
  return session.messages.some((m) => {
    const id = messageProvenance(m as object)?.id;
    return id !== undefined && ids.has(id);
  });
}

/** Fold an ended chat turn nobody here owns into its chat. */
export async function saveOrphanedChatTurn(op: Op, finished: boolean, ctx: ServerContext): Promise<boolean> {
  if (op.type !== OP_TYPE.chatTurn || !op.sessionId || owned.has(op.id)) return false;
  if (await alreadySaved(op, ctx)) return false;
  const { persistTurnState } = await import("./canonical-run.js");
  const session = ctx.getOrCreateSession(op.sessionId);
  if (session.messages.length === 0) {
    // Named in memory when the turn started, which died with the process.
    const { titleFromFirstMessage } = await import("./orchestrator.js");
    session.title = titleFromFirstMessage(op.task);
  }
  await persistTurnState({
    canonicalOpId: op.id, message: op.task, assistantText: "",
    session, ctx, sessionId: op.sessionId,
    images: [], interrupted: !finished,
  });
  logger.info(`[orphaned-turn] saved ${op.id} into ${op.sessionId} (${finished ? "finished" : "cut off"})`);
  return true;
}

/** Watch every op that ends, from boot on: registered before the restart sweep
 *  recovers anything. Returns the unregister. */
export function watchOrphanedChatTurns(getCtx: () => ServerContext): () => void {
  return registerTerminalObserver((op, state) => {
    if (op.type !== OP_TYPE.chatTurn || owned.has(op.id)) return;
    saveOrphanedChatTurn(op, state === "succeeded", getCtx()).catch((e: Error) => {
      logger.warn(`[orphaned-turn] could not save ${op.id}: ${e.message}`);
    });
  });
}
