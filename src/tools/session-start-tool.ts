/**
 * session_start — offer a separate piece of work its own chat.
 *
 * Some work is a task of its own: a follow-up noticed mid-conversation, a
 * research question worth its own thread, a fix that should not interleave
 * with the chat it came up in. A background worker (op_submit_async) does the
 * work but cannot be opened, steered or asked about; a chat can. So the agent
 * offers one: a card under its reply with a title and the brief it wrote,
 * shown live and from history from the result's `metadata.sessionOffer` (like
 * show_card's card and wrap_up's box), on the desktop and the phone.
 *
 * It starts nothing. The user's tap starts it (POST /api/sessions/start,
 * routes/sessions-start.ts): a new chat linked to this one, whose first message
 * is the brief, runs its turn on its own, and this chat hears when it is done
 * (session/linked-chat.ts). A brief is what the new chat knows: it does not
 * see this conversation.
 */
import type { ToolDefinition, ToolResult } from "../types.js";

/** The offer as the clients draw it (metadata.sessionOffer; agentxos progress.ts). */
export interface SessionOffer {
  title: string;
  brief: string;
}

export const SESSION_TITLE_MAX = 60;
export const SESSION_BRIEF_MAX = 4000;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The offer the arguments describe; null without a title or brief. */
export function sessionOfferOf(args: Record<string, unknown>): SessionOffer | null {
  const title = text(args.title, SESSION_TITLE_MAX);
  const brief = text(args.brief, SESSION_BRIEF_MAX);
  return title && brief ? { title, brief } : null;
}

export const sessionStartTool: ToolDefinition = {
  name: "session_start",
  compactDescription: "Offer a separate task its own chat: the user taps the card to start it; it runs on its own and reports back here.",
  description:
    "Offer a separate piece of work its own chat, as a card under your reply the user taps to start. Use it for a task of its own " +
    "that should not interleave with this conversation: a follow-up you noticed, a research question worth its own thread, a fix " +
    "unrelated to what the user is doing now. Not for the work the user just asked you to do here, and not for a quick lookup. " +
    "`title`: a few words naming the task. `brief`: everything the new chat needs, since it does not see this conversation: the " +
    "goal, the files or area, what you already found, constraints, and what done looks like. The new chat runs its first turn on " +
    "its own and this chat is told when it finishes. In Code mode it is a code session on this same folder, running while you keep " +
    "working: offer only work whose files don't overlap what you are changing, and say in the brief which files are its. " +
    "Say in one line why it is worth its own chat; nothing starts until the user taps.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: `A few words naming the task (at most ${SESSION_TITLE_MAX} characters).` },
      brief: { type: "string", description: "The new chat's first message: goal, area, what is known, constraints, what done looks like." },
    },
    required: ["title", "brief"],
  },
  async execute(args): Promise<ToolResult> {
    const sessionOffer = sessionOfferOf(args);
    if (sessionOffer === null) return { content: "session_start needs a title and a brief.", isError: true };
    return {
      content: `Offered: a "${sessionOffer.title}" card is under your reply. Nothing has started; the user taps it to start the chat. Don't do this work here unless they ask.`,
      metadata: { sessionOffer },
    };
  },
};
