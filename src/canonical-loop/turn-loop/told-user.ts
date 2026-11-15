// What LAX told the user outside this chat, as one line of the situational
// digest (situational-awareness.ts).
//
// The mail watcher, a scheduled job or a finished background run writes to the
// user through their inbox (src/inbox/), often to their phone. A new chat had
// no idea it had happened: asked "you sent me a digest of 26 emails", the agent
// went looking and said it had found no digest (2026-11-14). The user reads
// one assistant, so every chat should know what that assistant already said.
//
// The items carry mail senders and subjects, text from outside, so the list is
// fenced as external content: it is something the user was shown, never an
// instruction.

import { wrapExternalContent } from "../../sanitize.js";

/** How far back a chat is told about. */
export const TOLD_USER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Items shown, newest first. */
export const TOLD_USER_CAP = 5;
/** Characters of one item's body: a digest's list is long, its first lines say what it was. */
const BODY_MAX = 900;

export interface ToldItem {
  title: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

function clipBody(body: string): string {
  const text = body.trim();
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

/** The digest line, or null when nothing was told. */
export function toldUserLine(items: readonly ToldItem[], now: Date): string | null {
  if (items.length === 0) return null;
  const list = items.map((item) => {
    const when = ago(now.getTime() - Math.max(item.createdAt, item.updatedAt ?? 0));
    const body = clipBody(item.body);
    return `- (${when}) ${item.title}${body ? `\n${body.split("\n").map((l) => `  ${l}`).join("\n")}` : ""}`;
  }).join("\n");
  return [
    "What you (LAX) told the user outside this chat in the last 24 hours, in their inbox and on their phone, newest first.",
    "You sent these: if the user mentions one, it is yours, and you can talk about it without searching for it.",
    wrapExternalContent(list, "inbox"),
  ].join("\n");
}
