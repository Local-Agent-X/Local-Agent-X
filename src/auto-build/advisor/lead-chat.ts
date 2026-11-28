/**
 * The build lead's chat: the chat that started the build. Its agent decides
 * what the engine does after each chunk, between whatever else it and the
 * owner are talking about, the way an agent running /greenfield does.
 *
 * The engine's decisions used to be fixed rules and one-shot advisor calls
 * with no memory of the build: a chunk that closed every finding it was given
 * was set aside after three rounds because the reviewer kept finding new ones,
 * and the whole build stopped behind it (label-check-sol, 2026-11-24). A lead
 * holds the build in one conversation, reads each outcome with what came
 * before, and decides the way the person running a build would.
 *
 * For one day the lead had a chat of its own, listed under the build's chat
 * ("Build lead: <project>"). The owner read the lead's reasoning there but
 * had a second chat to follow, and saw the engine's evidence posts as if they
 * were messages (2026-11-25). Now the engine's posts go into the build's own
 * chat as the app's messages, which the chat view does not draw
 * (public/js/chat-app-message.js), and what the owner sees is the lead
 * saying what it decided.
 *
 * A post waits for a turn already running (the owner's or the agent's) to end
 * (chat-ws/app-message.ts), so the owner can keep talking while a build runs.
 * Without a chat runner (tests, a headless run) there is no lead and the
 * engine's own rules decide.
 */
import { getChatHandler } from "../../chat-ws/chat-handler.js";
import { isUserChat, sendAppMessageWhenIdle } from "../../chat-ws/app-message.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("auto-build.lead-chat");

/** Who leads a build: the chat that started it. */
export interface BuildLeadRef {
  projectDir: string;
  /** The chat that started the build, which leads it. */
  originSessionId: string;
}

/** A build started by a tool with no chat behind it has a synthetic session id. */
export function canHaveLead(originSessionId: string | undefined): originSessionId is string {
  return Boolean(originSessionId) && !originSessionId!.startsWith("orchestrator-") && isUserChat(originSessionId!);
}

/** The chat that leads `ref`'s build, or null when no chat can take a turn. */
export function leadChatOf(ref: BuildLeadRef): string | null {
  return getChatHandler() && canHaveLead(ref.originSessionId) ? ref.originSessionId : null;
}

/** One post per chat at a time: a chat runs one turn at a time, and parallel
 *  chunks can reach a decision together. */
const queues = new Map<string, Promise<unknown>>();

/** Post a message into the lead's chat as the app's, after any post already
 *  queued and once no turn is running; resolves when the turn it starts ends.
 *  The message is composed when it is sent: null when there is nothing to
 *  send any more (the lead took it in the turn it was in, lead-channel.ts). */
export function runLeadTurn(sessionId: string, compose: () => string | null): Promise<void> {
  const prior = queues.get(sessionId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => new Promise<void>((resolve, reject) => {
    if (!sendAppMessageWhenIdle(sessionId, compose, resolve)) reject(new Error("the chat runner is not up"));
  }));
  queues.set(sessionId, next);
  void next.catch((e) => logger.warn(`[lead] ${sessionId} post failed: ${(e as Error).message}`)).finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  });
  return next;
}
