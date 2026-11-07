/**
 * A chat started from another (session_start's offer, routes/sessions-start.ts)
 * runs its first turn on its own and the chat it came from hears how it went.
 *
 * The turn runs through the same handler a typed message does
 * (chat-ws/chat-handler.ts, wired in server/lifecycle.ts), so it streams to
 * anyone viewing the new chat and goes through every gate a typed turn does.
 * It is the starting chat's child for trust: it starts with that chat's taint
 * and external-ingestion marks, and what it reads flows back when its turn
 * settles (canonical-loop inherit/returnSessionLineage, as for a delegated
 * worker). Without that, a chat whose own send was refused could put the same
 * bytes in a brief and have a clean chat send them (red team 2026-10-13, A4).
 *
 * When it settles, the outcome reaches the starting chat the way a finished
 * background worker's does: its next turn's prompt and a saved completion row
 * (ops/pending-notifications.ts), a heads-up if the user is idle there
 * (ops/idle-nudge.ts), and the inbox.
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { inheritSessionLineage, returnSessionLineage } from "../canonical-loop/index.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { inboxJobResult } from "../inbox/producers.js";
import { isHarnessRow } from "../harness-rows.js";
import { createLogger } from "../logger.js";
import type { ServerContext } from "../server-context.js";
import type { Session } from "../types.js";
import type { ChatMode } from "./mode.js";

const logger = createLogger("session.linked-chat");

const SUMMARY_CHARS = 400;

export interface LinkedChatStart {
  /** The chat that offered it. */
  originId: string;
  originTitle: string;
  /** The new chat, already saved, empty. */
  sessionId: string;
  title: string;
  brief: string;
  /** The starting chat's mode: a code session starts a code session. */
  mode?: ChatMode;
}

/** The new chat's first message: the brief, saying where it came from. */
export function firstMessage(start: Pick<LinkedChatStart, "originTitle" | "brief">): string {
  return `(Started from the chat "${start.originTitle}".)\n\n${start.brief}`;
}

/** How the turn went, read from the new chat's last reply. */
export function outcomeOf(session: Pick<Session, "messages"> | null): { status: "completed" | "failed"; summary: string } {
  const reply = [...(session?.messages ?? [])].reverse()
    .find((m) => m.role === "assistant" && !isHarnessRow(m) && typeof m.content === "string" && m.content.trim());
  if (!reply) return { status: "failed", summary: "It ended without a reply." };
  const text = String(reply.content).trim();
  return { status: "completed", summary: text.length > SUMMARY_CHARS ? `…${text.slice(-SUMMARY_CHARS)}` : text };
}

/** Run the new chat's first turn, then tell the starting chat how it went. */
export async function runLinkedChat(ctx: ServerContext, start: LinkedChatStart): Promise<void> {
  let outcome: { status: "completed" | "failed"; summary: string };
  const handler = getChatHandler();
  if (!handler) {
    outcome = { status: "failed", summary: "The chat could not start: the chat runner is not up yet." };
  } else {
    inheritSessionLineage(start.sessionId, start.originId);
    try {
      await handler(start.sessionId, firstMessage(start), [], { channel: "web", ...(start.mode ? { mode: start.mode } : {}) });
      await ctx.flushSession(start.sessionId);
      outcome = outcomeOf(ctx.sessionStore.load(start.sessionId));
    } catch (e) {
      logger.warn(`[linked-chat] ${start.sessionId} failed: ${(e as Error).message}`);
      outcome = { status: "failed", summary: `It stopped with an error: ${(e as Error).message}` };
    }
  }
  try {
    returnSessionLineage(start.sessionId, start.originId);
  } catch (e) {
    logger.error(`[linked-chat] lineage back to ${start.originId} failed: ${(e as Error).message}`);
  }
  pushPendingNotification(start.originId, {
    opId: `chat:${start.sessionId}`,
    status: outcome.status,
    summary: outcome.summary,
    filesChanged: [],
    task: start.title,
    completedAt: Date.now(),
    linkedChat: { sessionId: start.sessionId, title: start.title },
  });
  scheduleIdleNudge(start.originId, start.title);
  inboxJobResult({
    label: `Chat "${start.title}"`,
    outcome: outcome.status,
    summary: outcome.summary,
    key: `chat:${start.sessionId}`,
    link: { sessionId: start.sessionId },
  });
}
