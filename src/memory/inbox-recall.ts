// What LAX told the user outside a chat, made recallable from any chat.
//
// The inbox (src/inbox/) is where LAX writes to the user when no chat is in
// front of them: the mail watcher's alerts and morning digest, a scheduled
// job's result, an agent asking for them. Each new item is indexed here, the
// moment it is posted, as memory source "inbox" at the virtual path
// inbox/<item id>. A chat on any channel then finds it the way it finds
// another chat: by relevance, through the one cross-session query
// (tools/search/search-past-sessions.ts), when a new request starts
// (manager.ts startsNewRequest). "You sent me a digest of 26 emails" finds
// the digest, with its contents; a chat about something else pays nothing.
//
// The text repeats outside content (mail senders and subjects), so the source
// is untrusted (search-helpers.ts defaultTrust) and is rendered as recalled
// data, never instructions.

import { EventBus } from "../event-bus.js";
import { createLogger } from "../logger.js";
import { chunkText } from "./chunking.js";
import type { MemoryIndex } from "./index-core.js";
import type { Chunk } from "./types.js";

const logger = createLogger("memory.inbox-recall");

/** Virtual path root of indexed inbox items. The index sync never sweeps it
 *  (index-sync.ts): there is no file behind it to find. */
export const INBOX_PATH_ROOT = "inbox/";

export interface IndexableInboxItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: number;
}

export function inboxItemPath(id: string): string {
  return `${INBOX_PATH_ROOT}${id}`;
}

/** The text a search matches: when, what kind, and what the user was told. */
export function inboxItemText(item: IndexableInboxItem): string {
  const when = new Date(item.createdAt).toISOString();
  return `LAX told the user (${item.kind}, ${when}): ${item.title}\n${item.body}`.trim();
}

export async function indexInboxItem(memory: MemoryIndex, item: IndexableInboxItem): Promise<number> {
  const path = inboxItemPath(item.id);
  const { maxChunkChars, overlapChars } = memory.getChunkConfig();
  const chunks = chunkText(inboxItemText(item), path, "inbox", maxChunkChars, overlapChars, {
    date: new Date(item.createdAt).toISOString().slice(0, 10),
  }) as Chunk[];
  const r = await memory.indexChunksIdempotent(chunks, path, "inbox");
  memory["db"].prepare("INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, 'inbox', ?, ?, ?)")
    .run(path, `${item.createdAt}:${item.body.length}`, item.createdAt, item.body.length);
  return r.added;
}

let started = false;

/** Index every new inbox item as it is posted. Called once at boot. Never
 *  throws: a memory write must not touch the inbox. */
export function startInboxRecall(memory: () => MemoryIndex): void {
  if (started) return;
  started = true;
  EventBus.on("inbox:posted", ({ item }) => {
    void indexInboxItem(memory(), item).catch((e) => {
      logger.warn(`[inbox-recall] item ${item.id} not indexed: ${(e as Error).message}`);
    });
  });
}
