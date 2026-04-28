/**
 * Per-process browser serialization. The shared BrowserManager + observation
 * registry race when two sessions enqueue actions concurrently — e.g. session
 * A clicks ref [3] mid-navigate while session B's snapshot reassigns refs.
 * Every tool entry funnels through this promise chain so only one action runs
 * at a time, and we track the current owner so we can log session handovers.
 */
import { createLogger } from "../logger.js";
const log = createLogger("browser.mutex");

let chain: Promise<unknown> = Promise.resolve();
let currentOwner: string | null = null;

export function withBrowserLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  onQueued?: () => void
): Promise<T> {
  const queued = currentOwner !== null && currentOwner !== sessionId;
  if (queued && onQueued) {
    try { onQueued(); } catch {}
  }
  const next = chain.then(async () => {
    const prev = currentOwner;
    if (prev !== null && prev !== sessionId) {
      log.info(`[browser-mutex] handover ${prev} -> ${sessionId}`);
    }
    currentOwner = sessionId;
    try {
      return await fn();
    } finally {
      if (currentOwner === sessionId) currentOwner = null;
    }
  });
  // Catch chain errors so a single tool failure doesn't poison every later
  // browser action with the same rejection.
  chain = next.catch(() => {});
  return next;
}

export function getCurrentBrowserOwnerSessionId(): string | null {
  return currentOwner;
}
