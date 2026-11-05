/**
 * What a spoken turn shares with a typed one on the same thread. The voice
 * client sends the chat thread's own session id, so a spoken turn and a typed
 * turn can land on one session; voice-ws.ts used to run with no turn lock, no
 * stale-writer check, a full rewrite of `session.messages`, no end-of-turn
 * memory pass and no threat engine, so the two could run at once and the later
 * save erased the other's rows. These are the chat turn's own pieces
 * (session/turn-lock.ts, routes/chat/append-turn.ts, MemoryManager.persistTurn,
 * ThreatEngine), applied to the spoken turn.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isCurrentTurnWriter, releaseTurn, tryAcquireOrReplace } from "../session/turn-lock.js";
import { appendTurnToSession } from "../routes/chat/append-turn.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { MemoryManager } from "../memory/index.js";
import type { Session } from "../types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.voice-turn-guard");

/** Spoken when a typed turn on this thread has already made a committing call. */
export const VOICE_BUSY_REPLY = "I'm still finishing something from the chat. Give me a moment and ask again.";

export interface VoiceTurnSlot {
  /** Aborts on barge-in and when a newer turn on the session replaces this one. */
  signal: AbortSignal;
  /** Stops this turn (the canary watch uses it). */
  abort(): void;
  /** Gives the slot back, unless a newer turn already holds it. */
  release(): void;
}

/**
 * Take the session's turn slot the way a typed message does: a running turn
 * that has not committed anything is aborted and awaited (its rows are saved
 * before this one reads the thread); one that has is left alone, and null
 * comes back.
 */
export async function claimVoiceTurn(sessionId: string, bargeIn: AbortSignal): Promise<VoiceTurnSlot | null> {
  const turn = new AbortController();
  const onBargeIn = () => turn.abort();
  if (bargeIn.aborted) turn.abort();
  else bargeIn.addEventListener("abort", onBargeIn, { once: true });
  const decision = await tryAcquireOrReplace(sessionId, turn, "voice");
  if (!decision.allowed) {
    bargeIn.removeEventListener("abort", onBargeIn);
    logger.info(`[voice] turn refused: a committing turn is running on ${sessionId}`);
    return null;
  }
  return {
    signal: turn.signal,
    abort: () => turn.abort(),
    release: () => {
      bargeIn.removeEventListener("abort", onBargeIn);
      if (isCurrentTurnWriter(sessionId, turn.signal)) releaseTurn(sessionId);
    },
  };
}

/** Watch the spoken stream for this session's canary, as the chat stream does;
 *  a trip aborts the turn. */
export function canaryWatch(threatEngine: ThreatEngine, abort: () => void): (delta: string) => boolean {
  let tail = "";
  return (delta) => {
    tail = (tail + delta).slice(-200);
    if (!threatEngine.checkOutput(tail)) return false;
    logger.warn("[voice] canary tripped in a spoken reply; turn aborted");
    abort();
    return true;
  };
}

/**
 * The spoken turn's own op rows (tool calls and results included), for the
 * end-of-turn pass's untrusted-marker scan, as the typed turn reads them. Null
 * when the op is unknown or its rows cannot be read: the pass then declines.
 */
export async function voiceTurnRows(opId: string | undefined): Promise<unknown[] | null> {
  if (!opId) return null;
  try {
    const { readOpMessages, opMessageRowToChatParam } = await import("../canonical-loop/index.js");
    const rows = readOpMessages(opId)
      .filter((row) => !row.messageId.startsWith("hist-"))
      .map((row) => opMessageRowToChatParam(row))
      .filter((param) => param !== null);
    return rows.length > 0 ? rows : null;
  } catch (e) {
    logger.warn(`[voice] op rows unreadable for the memory pass: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Add the turn's rows to the thread and run the end-of-turn memory pass. A turn
 * a newer one replaced saves nothing (its view of the thread is stale). Returns
 * whether it saved.
 */
export async function commitVoiceTurn(input: {
  session: Session;
  sessionId: string;
  turnSignal: AbortSignal;
  rows: ChatCompletionMessageParam[];
  /** The op's rows for the memory pass's marker scan (voiceTurnRows). */
  turnMessages: unknown[] | null;
  userText: string;
  replyText: string;
  memoryManager: Pick<MemoryManager, "persistTurn">;
  saveSession: (session: Session) => unknown;
}): Promise<boolean> {
  const { session, sessionId } = input;
  if (!isCurrentTurnWriter(sessionId, input.turnSignal)) {
    logger.warn(`[voice] stale turn superseded by a newer turn; not saving (sess=${sessionId.slice(0, 16)})`);
    return false;
  }
  appendTurnToSession(session, input.rows);
  session.updatedAt = Date.now();
  if (input.replyText) {
    try {
      await input.memoryManager.persistTurn({
        userMessage: input.userText,
        agentResponse: input.replyText,
        sessionId,
        hasExternalTaint: hasExternalIngestion(sessionId),
        turnMessages: input.turnMessages,
      });
    } catch (e) {
      logger.warn(`[voice] persistTurn failed (proceeding): ${(e as Error).message}`);
    }
  }
  void input.saveSession(session);
  return true;
}
