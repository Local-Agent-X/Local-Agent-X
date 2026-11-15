// What LAX told the user outside this chat, as one line of the situational
// digest (situational-awareness.ts): the titles of the last few inbox items.
//
// The mail watcher, a scheduled job or a finished background run writes to the
// user through their inbox (src/inbox/), often to their phone. Asked "you sent
// me a digest of 26 emails", a new chat went looking and said it had found no
// digest (2026-11-14). The contents now reach a chat by relevance, like any
// other chat's (memory/inbox-recall.ts). These titles are for what relevance
// cannot match: "what did you just send me?" shares no words with the item.
// Titles only, so every request pays a few dozen tokens, not the contents.
//
// The titles carry mail senders and subjects, text from outside, so the list
// is fenced as external content: something the user was shown, never an
// instruction.

import { wrapExternalContent } from "../../sanitize.js";

/** How far back a chat is told about. */
export const TOLD_USER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Items shown, newest first. */
export const TOLD_USER_CAP = 3;
const TITLE_MAX = 140;

export interface ToldItem {
  title: string;
  createdAt: number;
  updatedAt?: number;
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

/** The digest line, or null when nothing was told. */
export function toldUserLine(items: readonly ToldItem[], now: Date): string | null {
  if (items.length === 0) return null;
  const list = items.map((item) => {
    const when = ago(now.getTime() - Math.max(item.createdAt, item.updatedAt ?? 0));
    const title = item.title.length > TITLE_MAX ? `${item.title.slice(0, TITLE_MAX - 1)}…` : item.title;
    return `- (${when}) ${title}`;
  }).join("\n");
  return [
    "What you (LAX) last told the user outside this chat (their inbox and phone, last 24 hours, newest first).",
    "You sent these. If the user asks about one, it is yours: what it said is in your recalled memories, or search_past_sessions finds it.",
    wrapExternalContent(list, "inbox"),
  ].join("\n");
}
