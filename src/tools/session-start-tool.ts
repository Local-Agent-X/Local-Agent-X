/**
 * session_start — give a separate piece of work its own chat.
 *
 * Some work is a task of its own: a follow-up noticed mid-conversation, a
 * research question worth its own thread, a new project the user asked for.
 * A background worker (op_submit_async) does the work but cannot be opened,
 * steered or asked about; a chat can.
 *
 * By default it starts nothing: it offers a card under the reply with a title
 * and the brief it wrote, shown live and from history from the result's
 * `metadata.sessionOffer` (like show_card's card and wrap_up's box), on the
 * desktop and the phone. The user's tap starts it (POST /api/sessions/start).
 *
 * `start: "now"` starts it at once, for work the user asked for in this chat
 * ("start 4 new projects"). That is allowed only from a chat a person is in
 * (the local call context) that has taken in no outside content: a web page,
 * a file or an email that asked for a chat would have to come in through this
 * chat, and then the tap is the user's yes. Otherwise it falls back to the card.
 *
 * `folder` starts the chat in Code mode on a new project folder,
 * `workspace/apps/<folder>` (session/start-linked-chat.ts). Either way the new
 * chat runs its first turn on its own and this chat hears when it is done
 * (session/linked-chat.ts). A brief is what the new chat knows: it does not
 * see this conversation.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { callContextOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { getLinkedChatStarter, StartChatError } from "../session/start-linked-chat.js";

/** The offer as the clients draw it (metadata.sessionOffer; agentxos progress.ts). */
export interface SessionOffer {
  title: string;
  brief: string;
  /** A new project folder name: the chat runs in Code mode on `workspace/apps/<folder>`. */
  folder?: string;
}

export const SESSION_TITLE_MAX = 60;
export const SESSION_BRIEF_MAX = 4000;
const FOLDER_MAX = 64;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The offer the arguments describe; null without a title or brief. */
export function sessionOfferOf(args: Record<string, unknown>): SessionOffer | null {
  const title = text(args.title, SESSION_TITLE_MAX);
  const brief = text(args.brief, SESSION_BRIEF_MAX);
  const folder = text(args.folder, FOLDER_MAX);
  return title && brief ? { title, brief, ...(folder ? { folder } : {}) } : null;
}

/** Why a "now" start becomes a card, or null when it may start now. */
export function startNowRefusal(args: Record<string, unknown>): string | null {
  if (callContextOf(args) !== "local") return "it was not asked for from a chat a person is in";
  const sessionId = sessionIdOf(args);
  if (!sessionId) return "the chat it came from is unknown";
  if (hasExternalIngestion(sessionId)) return "this chat has read outside content (a page, a file or a message), so the user's tap is the yes";
  return null;
}

function offered(offer: SessionOffer, note = ""): ToolResult {
  return {
    content: `Offered: a "${offer.title}" card is under your reply.${note} Nothing has started; the user taps it to start the chat. ` +
      "Don't do this work here unless they ask.",
    metadata: { sessionOffer: offer },
  };
}

export const sessionStartTool: ToolDefinition = {
  name: "session_start",
  compactDescription: "Give a separate task its own chat: offered as a card, or started now when the user asked for it here.",
  description:
    "Give a separate piece of work its own chat. By default it is a card under your reply the user taps to start: " +
    "use that for a task of its own you noticed (a follow-up, a research question worth its own thread, a fix " +
    "unrelated to what the user is doing now), never for the work the user just asked you to do here, and not for a " +
    "quick lookup. When the user asked in this chat for work in chats of their own (\"start 3 new projects\", " +
    "\"run each of these in its own chat\"), pass `start: \"now\"`, one call per chat: it starts at once and you " +
    "say so, or becomes a card if it cannot start here. `folder`: for a new project, its folder name; the chat runs " +
    "in Code mode on `workspace/apps/<folder>` (created if missing; it opens on the phone too). Without it the chat " +
    "works where this one does: in Code mode on this same folder, so offer only work whose files don't overlap " +
    "yours, and say in the brief which files are its. `title`: a few words naming the task. `brief`: everything the " +
    "new chat needs, since it does not see this conversation: the goal, the files or area, what you found, " +
    "constraints, what done looks like (for a new project: run /greenfield and the idea). The new chat runs its " +
    "first turn on its own and this chat is told when it finishes.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: `A few words naming the task (at most ${SESSION_TITLE_MAX} characters).` },
      brief: { type: "string", description: "The new chat's first message: goal, area, what is known, constraints, what done looks like." },
      folder: { type: "string", description: "A new project's folder name (letters, digits, dot, dash, underscore): the chat runs in Code mode on workspace/apps/<folder>." },
      start: { type: "string", enum: ["now", "offer"], description: "\"now\" when the user asked for this chat in this conversation; default \"offer\" (a card)." },
    },
    required: ["title", "brief"],
  },
  async execute(args): Promise<ToolResult> {
    const offer = sessionOfferOf(args);
    if (offer === null) return { content: "session_start needs a title and a brief.", isError: true };
    if (args.start !== "now") return offered(offer);
    const refusal = startNowRefusal(args);
    const starter = getLinkedChatStarter();
    if (refusal || !starter) return offered(offer, ` It could not start on its own: ${refusal ?? "the chat runner is not up"}.`);
    try {
      const chat = await starter({ originId: sessionIdOf(args)!, ...offer });
      return {
        content: `Started "${chat.title}" in its own chat${chat.folder ? `, in Code mode on ${chat.folder}` : ""}. ` +
          "It runs its first turn on its own; you'll hear here when it finishes. Don't do this work here.",
        metadata: { sessionStarted: { sessionId: chat.sessionId, title: chat.title, ...(chat.folder ? { folder: chat.folder } : {}) } },
      };
    } catch (e) {
      if (e instanceof StartChatError) return { content: `session_start could not start the chat: ${e.message}`, isError: true };
      throw e;
    }
  },
};
