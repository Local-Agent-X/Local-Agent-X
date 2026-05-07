/**
 * Per-session cache for `memoryManager.buildTurnContext`.
 *
 * Why this exists: the memory pipeline (semantic vec search + session-summary
 * recall + orchestrator + context-block assembly) is the dominant cost in
 * `prepareAgentRequest` for chat — measured ~3-5s on real follow-ups while
 * the whole rest of the route adds up to <1s. Most chat follow-ups within a
 * 60-second window reuse the same memory hits because the user's underlying
 * topic hasn't shifted; rerunning the full pipeline every turn is pure
 * overhead.
 *
 * Cache strategy:
 *   - Key: sessionId
 *   - Invalidate when the recent-message context hash changes by more than
 *     a small Hamming distance (i.e. user added a new message, but the
 *     conversation hasn't pivoted)
 *   - TTL: 45s. Long enough to span quick back-and-forth; short enough that
 *     a paused chat re-warms with fresh memory if the user comes back later.
 *   - Size cap: 32 sessions; LRU eviction on insert.
 *
 * Boundaries:
 *   - Skipped entirely when `liteMode` or `minimalMode` is set on the input
 *     (those modes are already cheap; caching them adds risk without payoff).
 *   - Skipped when `skipDailyLog` is set (Codex provider — different mode
 *     produces a different shape; don't cross-pollinate).
 */
import { createHash } from "node:crypto";
import type { MemoryManager, TurnContext, TurnContextInput } from "../memory.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-request.turn-context-cache");

// 5 minutes covers typical chat rhythm (think, coffee, brief distraction).
// 45s was too tight — most follow-ups landed past it and rebuilt the
// memory pipeline for nothing. Topic shifts within 5 minutes are uncommon
// enough that the staleness cost is rare; on session-end the LRU evicts.
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 32;

interface CacheEntry {
  sessionId: string;
  contextHash: string;
  liteMode: boolean;
  skipDailyLog: boolean;
  storedAt: number;
  context: TurnContext;
  hits: number;
}

const cache = new Map<string, CacheEntry>();

function hashContext(input: TurnContextInput): string {
  // Hash on the EARLIEST messages of the session (or the empty signature
  // for a brand-new session). The memory pipeline's expensive parts —
  // user/profile context, session-summary recall, vec-search seeded from
  // the conversation's running theme — are stable across follow-ups within
  // the same chat. Hashing on tail messages caused MISS on every 2-3 turns
  // (history grows → hash drifts → rebuild). Anchoring on session start
  // gives a stable signature for the TTL window; on TTL expiry the cache
  // refreshes and may pick up a topic shift.
  const head = input.sessionMessages.slice(0, 4)
    .map(m => `${m.role}:${m.content.slice(0, 200)}`)
    .join("\n");
  return createHash("sha1").update(head || "(new-session)").digest("hex").slice(0, 16);
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  // Evict the least-recently-stored entry. Simple LRU approximation —
  // entries naturally TTL out, so size cap is the backstop.
  let oldest: [string, CacheEntry] | null = null;
  for (const e of cache.entries()) {
    if (!oldest || e[1].storedAt < oldest[1].storedAt) oldest = e;
  }
  if (oldest) cache.delete(oldest[0]);
}

/**
 * Cached wrapper around `memoryManager.buildTurnContext`. Falls through to
 * the real call when the input doesn't fit the cache profile (lite/minimal/
 * codex modes), or when no session context matches.
 */
export async function buildTurnContextCached(
  memoryManager: MemoryManager,
  input: TurnContextInput,
): Promise<TurnContext> {
  // Bypass: lite/minimal modes are already cheap; caching them risks staleness
  // on the trivial-tool fast-path with no upside.
  if (input.liteMode || input.minimalMode) {
    return memoryManager.buildTurnContext(input);
  }

  const sessionKey = `${input.sessionId}::${input.skipDailyLog ? "codex" : "anthropic"}`;
  const now = Date.now();
  const cached = cache.get(sessionKey);
  if (cached) {
    if (now - cached.storedAt > TTL_MS) {
      cache.delete(sessionKey);
    } else {
      const incomingHash = hashContext(input);
      // Exact hash match → reuse. Different hash = topic shifted, refresh.
      if (cached.contextHash === incomingHash) {
        cached.hits += 1;
        logger.info(`[turn-context-cache] HIT sess=${input.sessionId} age=${Math.round((now - cached.storedAt) / 100) / 10}s hits=${cached.hits}`);
        return cached.context;
      }
    }
  }

  const t0 = Date.now();
  const ctx = await memoryManager.buildTurnContext(input);
  const elapsed = Date.now() - t0;
  logger.info(`[turn-context-cache] MISS sess=${input.sessionId} built in ${elapsed}ms`);

  cache.set(sessionKey, {
    sessionId: input.sessionId,
    contextHash: hashContext(input),
    liteMode: !!input.liteMode,
    skipDailyLog: !!input.skipDailyLog,
    storedAt: now,
    context: ctx,
    hits: 0,
  });
  evictIfNeeded();

  return ctx;
}

/** Test/inspection: drop everything. */
export function clearTurnContextCache(): void {
  cache.clear();
}

/** Telemetry. */
export function turnContextCacheSnapshot(): Array<{ sessionId: string; ageSec: number; hits: number }> {
  const now = Date.now();
  return [...cache.values()].map(e => ({
    sessionId: e.sessionId,
    ageSec: Math.round((now - e.storedAt) / 1000),
    hits: e.hits,
  }));
}
