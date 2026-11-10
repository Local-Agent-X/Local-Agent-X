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
import { harnessRowKind, isHarnessRow } from "../harness-rows.js";

const logger = createLogger("server.voice-turn-guard");

/** The user's spoken words as their saved row. Images they showed ride on it the way a
 *  typed message's do (run-chat-turn persistTurnState), so the chat shows them and the
 *  next turns can see them again; a glance (a call's camera frame) does not: the agent
 *  saw it on this turn, and the chat is not a photo roll of everything it looked at. */
export function spokenUserRow(
  text: string,
  images: ReadonlyArray<{ name: string; url: string; glance?: true }>,
): ChatCompletionMessageParam & { images?: Array<{ name: string; url: string }> } {
  const kept = images.filter((im) => im.glance !== true);
  return kept.length > 0
    ? { role: "user", content: text, images: kept.map((im) => ({ name: im.name, url: im.url })) }
    : { role: "user", content: text };
}

/**
 * The rows a spoken turn on a local wire read after the user's message that
 * the next request must replay in place: the recall row the op was seeded with
 * (agent-runner/prompt.ts splitForChatThread) and the situational digest the
 * loop wrote (turn-loop/local-digest-row.ts). Saved with the turn as chat
 * saves them, so the next spoken or typed message extends this one and a
 * local runtime re-reads only what is new. `turnMessages` is the run's
 * AgentTurn.messages: [system, ...history, user, ...rows the op added].
 */
export function carriedHarnessRows(turnMessages: readonly ChatCompletionMessageParam[], historyLength: number): ChatCompletionMessageParam[] {
  return turnMessages.slice(historyLength + 2).filter((m) => {
    if (!isHarnessRow(m)) return false;
    const kind = harnessRowKind(m);
    return kind === "recall" || kind === "digest";
  });
}

/**
 * Every tool call a spoken turn made and its result, as the rows a typed turn
 * saves, so the chat records what the call DID. Saved without them, a hand-off
 * to a worker left only the spoken "it's going out now": a typed message
 * minutes later had no trace that a send was underway, and could send it
 * again (2026-11-06). The calls ride structurally, never as text in the reply:
 * a "[Tool calls this turn: …]" line in the reply was echoed back aloud.
 *
 * The calls' rows carry no text: the turn's whole spoken reply is the
 * assistant row saved after them. A call without its result (the turn was cut
 * off mid-tool) is left out with any result that lost its call, since a
 * provider refuses a history whose call has no answer. Image rows a tool added
 * for the model to look at stay out, as before. A card's result keeps its
 * metadata, so the chat redraws it (memory/session-ui-projection.ts).
 */
export function carriedToolRows(turnMessages: readonly ChatCompletionMessageParam[], historyLength: number): ChatCompletionMessageParam[] {
  const rows = turnMessages.slice(historyLength + 2);
  const answered = new Set(rows.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  const out: ChatCompletionMessageParam[] = [];
  const ids = new Set<string>();
  for (const m of rows) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const calls = m.tool_calls.filter((c) => answered.has(c.id));
      if (calls.length === 0) continue;
      for (const c of calls) ids.add(c.id);
      out.push({ role: "assistant", content: "", tool_calls: calls });
    } else if (m.role === "tool" && ids.has(m.tool_call_id)) {
      out.push(m);
    }
  }
  return out;
}

/** A tool result's metadata that carries a card (show_card). */
export function isCardMetadata(md: unknown): md is { card: Record<string, unknown> } {
  const card = (md as { card?: unknown } | undefined)?.card;
  return typeof card === "object" && card !== null && typeof (card as { title?: unknown }).title === "string";
}

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
