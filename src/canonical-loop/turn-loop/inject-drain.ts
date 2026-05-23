// Mid-turn inject draining: messages the user typed during a previous turn
// or tool call, queued by chat-ws via pushInject(). Drained into
// op_messages BEFORE buildTurnInput so the adapter sees them inline as
// user messages on this turn. Mirrors agent-loop's interjectDrainMiddleware.
// Scoped to chat_turn so background/delegated workers sharing the session
// don't drain the user's chat-bound injects.

import { randomUUID } from "node:crypto";
import type { Op } from "../../ops/types.js";
import type { OpMessageRow } from "../types.js";
import { appendOpMessage, readOpMessages } from "../store.js";
import { emit } from "../event-emitter.js";
import { drainInjects } from "../../agent-loop/inject-queue.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.turn-loop.inject-drain");

export function drainInjectsIntoTurn(op: Op, turnIdx: number): void {
  const sessionId = getSessionForOp(op.id);
  if (!sessionId) return;
  const injects = drainInjects(sessionId);
  if (injects.length === 0) return;
  // Pair this with chat-ws's `[ws-chat] inject sess=… len=N` enqueue line
  // for end-to-end visibility — until this log existed there was no way to
  // confirm an inject ever made it into an iteration vs sat in the queue
  // past the turn's end. The legacy agent-loop has its own
  // interjectDrainMiddleware that logs separately; chat turns go through
  // the canonical-loop and this function instead, so the message logged
  // there never fired for chats.
  const totalChars = injects.reduce((s, t) => s + t.length, 0);
  logger.info(`[interject-drain] consumed=${injects.length} sess=${sessionId} op=${op.id} turn=${turnIdx} totalChars=${totalChars}`);
  // Offset past any pre-existing rows for this turn (e.g. the seeded turn-0
  // user message) so (op_id, turn_idx, seq_in_turn) stays unique.
  let seqInTurn = readOpMessages(op.id).filter(m => m.turnIdx === turnIdx).length;
  const now = new Date().toISOString();
  for (const text of injects) {
    // Lightweight temporal-context marker. The model already has the
    // conversation history (so it knows what task is active) — what it
    // doesn't otherwise know is that this message arrived WHILE a turn
    // was running, not after it ended. Marking that fact is real signal:
    // it nudges the model to treat the message as relevant to the
    // current work without prescribing an interpretation. Deliberately
    // does NOT say "this applies to the active task" — the user might
    // be redirecting, and biasing toward continuation would suppress
    // legitimate course corrections.
    const framed = `[mid-turn user message] ${text}`;
    const row: OpMessageRow = {
      messageId: `inject-${op.id}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId: op.id,
      turnIdx,
      seqInTurn,
      role: "user",
      content: { text: framed },
      createdAt: now,
    };
    appendOpMessage(row);
    emit(op.id, "message_appended", { turnIdx, role: row.role, messageId: row.messageId });
    seqInTurn += 1;
  }
}
