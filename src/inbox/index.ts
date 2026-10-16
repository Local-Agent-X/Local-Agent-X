// The user inbox: the one owner of "things the app needs to tell the user".
// Producers call postToInbox (usually through producers.ts); the HTTP routes
// (src/routes/inbox.ts) read and mutate it for the bell. See AGENTS.md here.

import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";
import { createInboxStore, type InboxStore } from "./store.js";
import type { InboxCounts, InboxFrame, InboxInput, InboxItem, StoredInboxItem } from "./types.js";

export type { InboxCounts, InboxFrame, InboxInput, InboxItem, InboxKind, InboxLink, InboxAction, InboxResolution, DeferredCallRecord, StoredInboxItem } from "./types.js";
export { INBOX_KINDS } from "./types.js";
export type { InboxStore, ApprovalClaim } from "./store.js";

const logger = createLogger("inbox");

let cached: { path: string; store: InboxStore } | null = null;

/** The process's store at <lax data dir>/inbox.json. Re-resolved when the data
 *  dir changes so tests pointing LAX_DATA_DIR at a temp dir get their own. */
export function inboxStore(): InboxStore {
  const path = join(getLaxDir(), "inbox.json");
  if (!cached || cached.path !== path) cached = { path, store: createInboxStore(path) };
  return cached.store;
}

/** What a client may see: the producer key, the dismiss stamp and the
 *  deferred-call record stay on the server. */
export function toInboxView(item: StoredInboxItem): InboxItem {
  const { key: _key, dismissedAt: _dismissed, deferredCall: _call, ...view } = item;
  return view;
}

export function listInbox(): { items: InboxItem[] } & InboxCounts {
  const store = inboxStore();
  return { items: store.list().map(toInboxView), ...store.counts() };
}

async function broadcast(frame: InboxFrame): Promise<void> {
  const { broadcastAll } = await import("../chat-ws/broadcast.js");
  broadcastAll(frame as unknown as Record<string, unknown>);
}

/**
 * Add (or, for a repeated key, update) an item and tell every open tab.
 * Never throws: a producer is some other subsystem's code path (a cron run,
 * the tool gate, an escalation), and failing to record a notice must not
 * fail that work.
 */
export function postToInbox(input: InboxInput): InboxItem | null {
  try {
    const store = inboxStore();
    const { item, created, changed } = store.post(input);
    const view = toInboxView(item);
    if (changed) {
      broadcast({ type: "inbox_item", item: view, created, ...store.counts() })
        .catch((e) => logger.warn(`[inbox] live frame not sent: ${(e as Error).message}`));
    }
    return view;
  } catch (e) {
    logger.warn(`[inbox] could not record "${input.title}": ${(e as Error).message}`);
    return null;
  }
}

/** Resolve open items a producer no longer stands behind (e.g. an update
 *  notice after the update landed). */
export function resolveInboxWhere(match: (item: StoredInboxItem) => boolean): number {
  try {
    const store = inboxStore();
    const count = store.resolveWhere(match);
    if (count > 0) {
      broadcast({ type: "inbox_changed", action: "resolve", ...store.counts() })
        .catch((e) => logger.warn(`[inbox] live frame not sent: ${(e as Error).message}`));
    }
    return count;
  } catch (e) {
    logger.warn(`[inbox] resolve failed: ${(e as Error).message}`);
    return 0;
  }
}
