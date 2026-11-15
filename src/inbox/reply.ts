// The user's reply to an inbox item: a chat about that item.
//
// LAX writes to the user in the inbox when no chat is in front of them (an
// important mail, the morning digest, a job's result). Replying to one opens a
// new chat whose first message is the user's words with the item quoted, and
// links the item to it: the item's Open goes there, and replying again
// continues the same chat. The chat is a real chat on the one chat runner, so
// anything the agent then wants to do (answer the mail, delete something)
// passes the same gates as a typed request.
//
// The quoted item can repeat outside text (a mail's sender, subject and
// preview), so it is fenced as external content, and a chat opened from such
// an item starts marked as having read outside content (data-lineage), as a
// chat that read the mail itself would be.

import { randomBytes } from "node:crypto";
import { wrapExternalContent } from "../sanitize.js";
import { inboxStore, toInboxView } from "./index.js";
import type { StoredInboxItem } from "./types.js";

export const REPLY_MAX_CHARS = 4000;
const TITLE_MAX = 60;

export type InboxReplyResult =
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; refused: "missing" | "empty" };

export interface InboxReplyDeps {
  /** True when a chat with this id is stored. */
  chatExists(sessionId: string): boolean;
  /** Save a new, empty chat. */
  createChat(chat: { id: string; title: string }): Promise<void>;
  /** Run one turn of a chat with the user's message, without waiting for it. */
  send(sessionId: string, message: string): void;
  /** Mark a chat as having read outside content. */
  markExternal(sessionId: string): void;
}

/** True when the item's text came from outside (mail). */
export function repeatsOutsideText(item: Pick<StoredInboxItem, "key">): boolean {
  return /^mail(-digest)?:/.test(item.key ?? "");
}

/** The new chat's first message: the user's words, then the item they answer. */
export function replyMessage(item: Pick<StoredInboxItem, "title" | "body" | "createdAt">, text: string): string {
  const when = new Date(item.createdAt).toLocaleString();
  const quoted = wrapExternalContent(`${item.title}\n${item.body}`.trim(), "inbox");
  return `${text}\n\n(I'm replying to what you sent to my inbox on ${when}:)\n${quoted}`;
}

export async function replyToInboxItem(id: string, rawText: string, deps: InboxReplyDeps): Promise<InboxReplyResult> {
  const text = rawText.trim().slice(0, REPLY_MAX_CHARS);
  if (!text) return { ok: false, refused: "empty" };
  const store = inboxStore();
  const item = store.get(id);
  if (!item) return { ok: false, refused: "missing" };

  const linked = item.link?.sessionId;
  if (linked && deps.chatExists(linked)) {
    store.markRead(id);
    deps.send(linked, text);
    return { ok: true, sessionId: linked, created: false };
  }

  const sessionId = `reply-${randomBytes(8).toString("hex")}`;
  const title = `Re: ${item.title}`;
  await deps.createChat({ id: sessionId, title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title });
  if (repeatsOutsideText(item)) deps.markExternal(sessionId);
  store.linkReplyChat(id, sessionId);
  deps.send(sessionId, replyMessage(item, text));
  return { ok: true, sessionId, created: true };
}

/** The item as clients see it after a reply (its link now names the chat). */
export function repliedView(id: string) {
  const stored = inboxStore().get(id);
  return stored ? toInboxView(stored) : undefined;
}
