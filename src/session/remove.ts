/**
 * Removing a chat: the two things "delete" can mean, in one place.
 *
 * Delete (removeChatFromLists): the chat leaves the chat lists on every
 * device (the desktop sidebar, the phone's drawer, a machine that syncs) and
 * its transcript stays: in memory, in search, and openable by id. The mark is
 * `removedAt` in the chat's own log, so sync carries it like any other change.
 * Delete used to unlink the log: the agent lost the conversation, and a
 * synced machine brought it back on the next pull, while clearing the sidebar
 * hid chats in one browser for 30 days.
 *
 * Erase (eraseChat): the user wants it gone. Every copy on this machine, its
 * search entries and its summary are removed, and a sync tombstone stops the
 * mirror or another machine bringing it back (sync/session-tombstones.ts).
 * Facts the agent already learned from it stay: a fact does not record which
 * chat it came from.
 *
 * Start fresh (startChatFresh) is the third: a chat whose id is reused (a
 * messaging thread, an app's IDE chat) starts over, its old transcript
 * archived, never unlinked.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { MemoryIndex, SessionStore } from "../memory/index.js";
import { repointFile } from "../memory/index-sync.js";
import type { SessionMetadata } from "../memory/session-metadata-cache.js";
import { isHiddenFromChatLists } from "../memory/synthetic-sessions.js";
import { tombstoneErasedSession } from "../sync/session-tombstones.js";
import type { Session } from "../types.js";
import { parseMessagingSessionTarget } from "./channel-registry.js";

/**
 * Whether a chat belongs in the user's chat lists: the sidebar, the phone's
 * drawer, chat search. A deleted chat comes back once something newer is
 * saved in it: a WhatsApp thread the user deleted reappears with its next
 * message, as it did when Delete unlinked the log and the message began a new one.
 */
export function isListedChat(meta: Pick<SessionMetadata, "id" | "removedAt" | "updatedAt">): boolean {
  const removed = meta.removedAt !== undefined && meta.removedAt >= meta.updatedAt;
  return !removed && !isHiddenFromChatLists(meta.id);
}

export interface ChatRemovalDeps {
  dataDir: string;
  sessionStore: SessionStore;
  memoryIndex: Pick<MemoryIndex, "forgetChunksAtPath" | "maintenanceDb">;
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => Promise<void>;
  flushSession: (id: string) => Promise<void>;
  dropSession: (id: string) => void;
}

/** Take one chat out of the chat lists, keeping its transcript. False when there is no such chat. */
export async function removeChatFromLists(deps: ChatRemovalDeps, id: string, now = Date.now()): Promise<boolean> {
  await deps.flushSession(id);
  if (!deps.sessionStore.load(id)) return false;
  const session = deps.getOrCreateSession(id);
  session.removedAt = now;
  // A later updatedAt is what makes sync carry the mark to another machine (sync/session-log-ahead.ts).
  session.updatedAt = now;
  await deps.saveSession(session);
  return true;
}

/**
 * Take every chat in Conversations off the lists: "Delete all" and the agent's
 * sidebar_clear. A project's chats, code sessions and WhatsApp/Telegram
 * threads stay; `keep` (the chat asking) stays too. Returns how many were removed.
 */
export async function removeAllChatsFromLists(deps: ChatRemovalDeps, keep?: string): Promise<number> {
  const targets = deps.sessionStore.list().filter((m) =>
    isListedChat(m) && m.mode !== "code" && !m.projectId && m.id !== keep && parseMessagingSessionTarget(m.id) === null);
  const now = Date.now();
  let removed = 0;
  for (const m of targets) if (await removeChatFromLists(deps, m.id, now)) removed++;
  return removed;
}

/**
 * Start a chat over under the same id: a WhatsApp or Telegram "/reset", the
 * app IDE's Fresh Chat. Its transcript moves to sessions-archive/ and stays in
 * memory (the index follows the move); the next message begins an empty chat.
 * Returns false when the chat had no log.
 */
export async function startChatFresh(deps: ChatRemovalDeps, id: string): Promise<boolean> {
  await deps.flushSession(id);
  deps.dropSession(id);
  return deps.sessionStore.archive(id, (oldPath, newPath) => {
    repointFile(deps.memoryIndex.maintenanceDb(), oldPath, newPath);
  });
}

/** Erase a chat on this machine and, through sync, everywhere. Returns false when nothing held it. */
export async function eraseChat(deps: ChatRemovalDeps, id: string): Promise<boolean> {
  const erased = await eraseLocalCopies(deps, id);
  tombstoneErasedSession(join(deps.dataDir, "sync-repo"), id);
  return erased;
}

/** Erase the copies of chats another machine erased (sync's onSessionsErased). */
export async function eraseChatsErasedElsewhere(deps: ChatRemovalDeps, ids: readonly string[]): Promise<void> {
  for (const id of ids) await eraseLocalCopies(deps, id);
}

async function eraseLocalCopies(deps: ChatRemovalDeps, id: string): Promise<boolean> {
  // Wait out a pending write, then forget the cached copy so nothing saves it back.
  await deps.flushSession(id);
  deps.dropSession(id);
  const transcripts = deps.sessionStore.erase(id);
  for (const p of transcripts) deps.memoryIndex.forgetChunksAtPath(p);
  const summary = join(deps.dataDir, "memory", "session-summaries", `${id}.md`);
  const hadSummary = existsSync(summary);
  if (hadSummary) {
    unlinkSync(summary);
    deps.memoryIndex.forgetChunksAtPath(summary);
  }
  return transcripts.length > 0 || hadSummary;
}

let bound: ChatRemovalDeps | null = null;

/** Called once at boot so a tool, which has no server context, can reach the chat lists. */
export function bindChatRemoval(deps: ChatRemovalDeps): void {
  bound = deps;
}

/** The deps bound at boot; null before the server is up. */
export function boundChatRemoval(): ChatRemovalDeps | null {
  return bound;
}
