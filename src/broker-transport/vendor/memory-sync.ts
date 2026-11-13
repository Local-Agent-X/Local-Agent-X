// The desktop's memory sync as the phone sees it, over the device http tunnel.
//
// The desktop syncs its memory, chats and settings with the user's other computers
// through a private git repo (Local Agent X's Settings → Sync). The phone can read
// where that stands and press the desktop's three buttons (sync now, force pull,
// force push) from anywhere; it cannot turn sync on, name a repo or see one:
// setting it up stays on the desktop, so a paired phone can never point the user's
// memory somewhere else.

import { asRecord, asString } from "./guards.js";

/** Where memory sync stands (GET). */
export const MEMORY_SYNC_PATH = "/api/sync/device";
/** Each action is a POST with no body. A sync can outlast a tunnel request, so each
 *  answers at once, usually "syncing", and the phone reads MEMORY_SYNC_PATH until it
 *  settles. While one runs, another answers with the status and starts nothing. */
/** Sync now: send this computer's changes to the repo, then take the other computers'. */
export const MEMORY_SYNC_RUN_PATH = "/api/sync/device/run";
/** Force pull: take what is in the repo onto this computer. */
export const MEMORY_SYNC_PULL_PATH = "/api/sync/device/pull";
/** Force push: send this computer's changes to the repo. */
export const MEMORY_SYNC_PUSH_PATH = "/api/sync/device/push";

export type MemorySyncState =
  /** Sync is not set up or turned on at the desktop; only the desktop can do that. */
  | "off"
  | "idle"
  | "syncing"
  /** The last sync failed; `message` says why. */
  | "failed";

export interface MemorySyncStatus {
  state: MemorySyncState;
  /** When this computer last finished a sync (epoch ms), or null if it never has
   *  since the desktop started. */
  lastSync: number | null;
  /** What the last sync did ("Downloaded latest."), or why it failed. */
  message?: string;
}

const MEMORY_SYNC_STATES: ReadonlySet<string> = new Set(["off", "idle", "syncing", "failed"]);

export function parseMemorySyncStatus(raw: unknown): MemorySyncStatus | null {
  const msg = asRecord(raw);
  if (msg === null || typeof msg.state !== "string" || !MEMORY_SYNC_STATES.has(msg.state)) return null;
  const lastSync = typeof msg.lastSync === "number" && Number.isFinite(msg.lastSync) && msg.lastSync > 0 ? msg.lastSync : null;
  const message = asString(msg.message);
  return { state: msg.state as MemorySyncState, lastSync, ...(message ? { message } : {}) };
}
