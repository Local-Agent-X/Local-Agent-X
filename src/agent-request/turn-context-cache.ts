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
 *   - Key: sessionId (+provider variant)
 *   - Invalidate when the CURRENT query's 64-bit SimHash fingerprint drifts
 *     from the stored one by more than a small Hamming distance — a rephrase
 *     of the same topic reuses the entry; a pivot to a different topic
 *     rebuilds so the memories match what the user is now asking about.
 *   - TTL: 45s. Long enough to span quick back-and-forth; short enough that
 *     the <current_datetime> baked into the context block never drifts far
 *     and a paused chat re-warms with fresh memory on return.
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

// 45 seconds. The context block bakes in <current_datetime> and the memory
// hits for the CURRENT topic, so a long TTL serves a frozen clock and stale
// memories. A previous 30-min TTL anchored on the first user message replayed
// turn 1's memories on turn 4 about a different project. 45s still spans the
// rapid back-and-forth the cache exists for (measured follow-up gaps in quick
// chat are well under a minute); anything slower pays the rebuild and gets a
// correct clock + fresh recall.
const TTL_MS = 45 * 1000;
const MAX_ENTRIES = 32;
// Backstop: a full context build measures 3-5s on real follow-ups; anything
// past 10s means a retrieval dependency is wedged (Ollama embed, reranker
// load). The turn ships without memory context rather than freezing — the
// build keeps running in background and populates the cache for the next
// turn. This should ~never fire in healthy operation; when it does, the warn
// log (with a running count) is the signal that retrieval is degraded, not
// business as usual.
const BUILD_WALLCLOCK_MS = 10 * 1000;
const BUILD_TIMEOUT_SENTINEL = Symbol("turn-context-build-timeout");
let wallclockTrips = 0;
// Hamming-distance budget on the 64-bit SimHash of the current query.
// <= 6 differing bits ≈ a rephrase of the same ask; more = a topic pivot.
const FINGERPRINT_MATCH_MAX_DISTANCE = 6;

interface CacheEntry {
  sessionId: string;
  contextFingerprint: bigint;
  liteMode: boolean;
  skipDailyLog: boolean;
  storedAt: number;
  context: TurnContext;
  hits: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * 64-bit SimHash of the CURRENT user message. Anchoring on the current query
 * (not the first message of the session — the old bug) means a mid-session
 * pivot to a different project changes the fingerprint and forces a rebuild,
 * while a same-topic rephrase lands within the Hamming budget and reuses the
 * cached context.
 */
function fingerprintContext(input: TurnContextInput): bigint {
  const tokens = (input.userMessage ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
  if (tokens.length === 0) return 0n;
  const votes = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const bits = createHash("sha1").update(token).digest().readBigUInt64BE(0);
    for (let i = 0; i < 64; i++) {
      votes[i] += (bits >> BigInt(i)) & 1n ? 1 : -1;
    }
  }
  let fp = 0n;
  for (let i = 0; i < 64; i++) {
    if (votes[i] > 0) fp |= 1n << BigInt(i);
  }
  return fp;
}

function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let d = 0;
  while (x > 0n) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
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
      const incoming = fingerprintContext(input);
      // Within the Hamming budget → same topic, reuse. Beyond it = pivot, refresh.
      if (hammingDistance(cached.contextFingerprint, incoming) <= FINGERPRINT_MATCH_MAX_DISTANCE) {
        cached.hits += 1;
        logger.info(`[turn-context-cache] HIT sess=${input.sessionId} age=${Math.round((now - cached.storedAt) / 100) / 10}s hits=${cached.hits}`);
        return cached.context;
      }
    }
  }

  const t0 = Date.now();
  const build = memoryManager.buildTurnContext(input).then((ctx) => {
    const elapsed = Date.now() - t0;
    logger.info(`[turn-context-cache] MISS sess=${input.sessionId} built in ${elapsed}ms`);
    // Store on completion even if the wallclock already gave up on this turn —
    // a late build warms the cache so the NEXT turn gets real memory context.
    cache.set(sessionKey, {
      sessionId: input.sessionId,
      contextFingerprint: fingerprintContext(input),
      liteMode: !!input.liteMode,
      skipDailyLog: !!input.skipDailyLog,
      storedAt: Date.now(),
      context: ctx,
      hits: 0,
    });
    evictIfNeeded();
    return ctx;
  });

  let timer: NodeJS.Timeout | undefined;
  const wallclock = new Promise<typeof BUILD_TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(BUILD_TIMEOUT_SENTINEL), BUILD_WALLCLOCK_MS);
    timer.unref?.();
  });
  const raced = await Promise.race([build, wallclock]).finally(() => clearTimeout(timer));
  if (raced === BUILD_TIMEOUT_SENTINEL) {
    wallclockTrips += 1;
    logger.warn(
      `[turn-context-cache] build exceeded ${BUILD_WALLCLOCK_MS}ms — shipping turn WITHOUT memory context (retrieval degraded; trip #${wallclockTrips}) sess=${input.sessionId}`,
    );
    build.catch(() => {});
    return {
      contextBlock: "",
      relevantMemories: "",
      smartContext: "",
      memoryContext: "",
      notifications: [],
      knownProjectsFound: false,
    };
  }
  return raced;
}

/** Test/inspection: drop everything. */
export function clearTurnContextCache(): void {
  cache.clear();
}

/**
 * Drop one session's cached turn-context (both provider variants) so the next
 * turn rebuilds it from current state. Called when a turn is INTERRUPTED: the
 * salvaged history changes what the memory/situational block should contain,
 * so the stale entry must be evicted rather than reused within its TTL.
 */
export function invalidateTurnContextCache(sessionId: string): void {
  cache.delete(`${sessionId}::anthropic`);
  cache.delete(`${sessionId}::codex`);
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
