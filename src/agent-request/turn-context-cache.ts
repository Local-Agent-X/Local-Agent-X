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
import type { MemoryManager, TurnContext, TurnContextInput } from "../memory/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("agent-request.turn-context-cache");

// 30 minutes — aligned with the warm-pool eviction TTL. Real chat has
// long natural pauses (lunch, meeting, coffee, walking away) and 5 min
// was killing context just past most "I came back to my desk" returns,
// so the user paid a 6-10s memory-pipeline rebuild on the FIRST turn
// after any longer break. 30 min covers normal workday rhythm; on actual
// session-end the LRU evicts. Staleness within 30 min is rare in practice;
// when it matters, the agent's memory_search tool fetches fresh data
// without the cache helping or hurting.
const TTL_MS = 30 * 60 * 1000;
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
  // Anchor the cache hash on the FIRST user message (or empty for a
  // brand-new session). The earlier strategy hashed `slice(0, 4)` of
  // session messages, but the first 4 message slots don't stabilize
  // until turn 4 — so turns 1-3 all paid the full ~6-10s memory-pipeline
  // cost on every follow-up. Empirically: 3 MISSes then 2 HITs in a
  // 5-turn session, exactly when users feel slowness least.
  //
  // Hashing on the first user message gives stability from turn 2
  // forward. Topic shifts within the TTL (5 min) are rare in chat
  // patterns; staleness on shift is handled by TTL expiry, not by
  // hash drift. On a brand-new session (no prior user message yet),
  // we use the CURRENT user message as the anchor — this means turn 1
  // and turn 2 share the same key (turn 1 stores it, turn 2 hits it).
  const firstUser =
    input.sessionMessages.find(m => m.role === "user")?.content ??
    input.userMessage ??
    "";
  const anchor = firstUser.slice(0, 200) || "(new-session)";
  return createHash("sha1").update(anchor).digest("hex").slice(0, 16);
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
