/**
 * Browser action serialization. By default each SESSION owns its own promise
 * chain, so independent sessions run their browser actions concurrently — one
 * session's slow (or wedged, up to the ~29s deadline) op no longer freezes every
 * other session's browser action. This is safe because each session now owns its
 * own BrowserManager + observation registry (see instance.ts) and, in every mode
 * except advanced-shared, its own Playwright context (see acquireSessionContext
 * in runtime.ts) — so there is no cross-session state to race.
 *
 * The ONE exception is advanced-shared mode: every session's tabs live in a
 * SINGLE shared Playwright context + cookie jar, so concurrent actions genuinely
 * race (session A clicks ref [3] mid-navigate while session B's snapshot
 * reassigns refs). There we retain a single global chain so only one action runs
 * at a time — behavior identical to the historical global serialization. The
 * mode is process-global (getRuntimeConfig().browserMode), so at any instant
 * every call takes the same branch; there is never a mixed-mode state.
 *
 * We track the current owner so we can log session handovers and decide when a
 * queued session must be told it is waiting.
 */
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";
const log = createLogger("browser.mutex");

// Minimum spacing between consecutive actions in the same session. This is
// reaction-time pacing, not a throughput cap: a real action (navigate, click,
// snapshot) already takes longer than this, so it adds zero delay in normal
// use. It only smooths a pathological instant-burst (a tight model loop firing
// no-op reads back-to-back) so the burst slows down instead of dead-stopping.
const MIN_ACTION_INTERVAL_MS = 200;
const lastActionStart = new Map<string, number>();

// Per-session serialization chains (isolated / continuity / in-app modes). Keyed
// by sessionId so independent sessions never block on each other's chain.
const sessionChains = new Map<string, Promise<unknown>>();
// The single global chain, used ONLY in advanced-shared mode where all sessions
// drive one shared Playwright context and therefore must serialize globally.
let sharedChain: Promise<unknown> = Promise.resolve();
let currentOwner: string | null = null;

/** Advanced-shared is the only mode that shares one Playwright context across
 *  sessions, so it is the only one that keeps global serialization. */
function isAdvancedSharedMode(): boolean {
  return getRuntimeConfig().browserMode === "advanced-shared";
}

export function withBrowserLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  onQueued?: () => void
): Promise<T> {
  const shared = isAdvancedSharedMode();
  // A session is "queued" only when it must wait behind a DIFFERENT session on
  // the same lock — which can only happen on the shared global chain. Under
  // per-session chains a call only ever waits behind ITSELF, which is not a
  // cross-session queue, so browser_queued stays silent (matching the old
  // currentOwner !== sessionId guard).
  const queued = shared && currentOwner !== null && currentOwner !== sessionId;
  if (queued && onQueued) {
    try { onQueued(); } catch {}
  }
  const prevChain = shared
    ? sharedChain
    : (sessionChains.get(sessionId) ?? Promise.resolve());
  const next = prevChain.then(async () => {
    const prev = currentOwner;
    if (prev !== null && prev !== sessionId) {
      log.info(`[browser-mutex] handover ${prev} -> ${sessionId}`);
    }
    currentOwner = sessionId;
    const sinceLast = Date.now() - (lastActionStart.get(sessionId) ?? 0);
    if (sinceLast < MIN_ACTION_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_ACTION_INTERVAL_MS - sinceLast));
    }
    lastActionStart.set(sessionId, Date.now());
    try {
      return await fn();
    } finally {
      if (currentOwner === sessionId) currentOwner = null;
    }
  });
  // Catch chain errors so a single tool failure doesn't poison every later
  // browser action queued on the same chain with that rejection.
  const settled = next.catch(() => {});
  if (shared) {
    sharedChain = settled;
  } else {
    sessionChains.set(sessionId, settled);
    // Self-evict the idle tail: once this action settles, if no later action
    // chained after it (the map still points at THIS promise), drop the entry
    // so sessionChains can't grow one resolved-promise entry per distinct
    // session forever. A future action for the session starts a fresh chain.
    void settled.then(() => {
      if (sessionChains.get(sessionId) === settled) sessionChains.delete(sessionId);
    });
  }
  return next;
}

export function getCurrentBrowserOwnerSessionId(): string | null {
  return currentOwner;
}

/** TEST-ONLY: count of live per-session chains, to prove idle sessions are
 *  evicted (no unbounded sessionChains growth). Not for production use. */
export function __sessionChainCountForTest(): number {
  return sessionChains.size;
}
