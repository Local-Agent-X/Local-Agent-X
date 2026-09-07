// Per-op summary STABILITY cache for turn-loop compaction.
//
// Why this exists: the turn loop never persists the compacted view — every
// turn rebuilds the message array from readOpMessages and re-runs
// compactHistory. Once an op is over the compaction threshold it is over it
// EVERY turn, and `safeSplitIndex` advances by the rows the last turn
// appended, so an uncached summarizer sees a DIFFERENT head each turn and
// emits DIFFERENT summary bytes at index 0. That makes turn N's array not a
// prefix of turn N+1's at index 0, so the Anthropic message-tier cache
// breakpoint can never hit — the whole conversation is re-written at 1.25x
// every turn and read back at 0.1x never. It also burns one summarizer call
// per turn forever.
//
// The chat lane already solved this (providers/truncate-history.ts): cache the
// LLM summary per covered prefix, hash-verify it before reuse, and only
// re-summarize once the uncovered gap has grown past
// summaryRefreshMinGrowth. This module is the same shape for the turn loop —
// keyed by opId, verified against the covered head, bounded and evicted.
//
// The reuse contract compactHistory relies on: a reused entry PINS the
// compaction boundary at `covered`, so the summary block is a pure function of
// the head it covers and the rows between `covered` and the freshly computed
// split index simply stay verbatim. Index 0 is then byte-identical turn over
// turn until a refresh, and the refresh costs exactly one miss + one re-write.

import type { CanonicalMessage } from "../contract-types.js";
import { TURN_SUMMARY_REFRESH_MIN_GROWTH } from "../../context-manager/compaction-policy.js";

// Bounded like the compaction breaker in compact-history.ts: evict the
// oldest-touched op when full. Mechanics, not policy.
const MAX_TRACKED_OPS = 500;

interface Entry {
  /** Number of leading rows the cached summary covers. */
  covered: number;
  /** Order-sensitive hash of those rows, so a stale/foreign head is never reused. */
  prefixHash: string;
  summary: string;
  touchedAt: number;
}

const cache = new Map<string, Entry>();

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rowFingerprint(m: CanonicalMessage): string {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  return `${m.messageId}:${m.role}:${c.length}`;
}

/** Order-sensitive rolling hash over the first `count` rows. */
export function hashHead(messages: CanonicalMessage[], count: number): string {
  let acc = 0x811c9dc5;
  for (let i = 0; i < count; i++) acc = fnv1a(`${acc.toString(36)}|${rowFingerprint(messages[i])}`);
  return `${acc.toString(36)}:${count}`;
}

/**
 * The cached summary to REUSE for this turn, or null when the op must
 * re-summarize. Reusable iff the entry covers a prefix of the current split
 * (`covered <= splitIdx`), that prefix is byte-identical to what was
 * summarized, and the head has not grown past the refresh threshold since.
 */
export function reusableSummary(
  opId: string,
  messages: CanonicalMessage[],
  splitIdx: number,
): { covered: number; summary: string } | null {
  const entry = cache.get(opId);
  if (!entry) return null;
  if (entry.covered <= 0 || entry.covered > splitIdx || entry.covered > messages.length) return null;
  if (splitIdx - entry.covered >= TURN_SUMMARY_REFRESH_MIN_GROWTH) return null;
  if (hashHead(messages, entry.covered) !== entry.prefixHash) return null;
  entry.touchedAt = Date.now();
  return { covered: entry.covered, summary: entry.summary };
}

/** Record a freshly computed summary as the op's stable head summary. */
export function storeSummary(
  opId: string,
  messages: CanonicalMessage[],
  covered: number,
  summary: string,
): void {
  if (!cache.has(opId) && cache.size >= MAX_TRACKED_OPS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, e] of cache) {
      if (e.touchedAt < oldestAt) { oldestAt = e.touchedAt; oldestKey = key; }
    }
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(opId, {
    covered,
    prefixHash: hashHead(messages, covered),
    summary,
    touchedAt: Date.now(),
  });
}

/** Drop one op's entry (op finished) or the whole cache (tests). */
export function clearSummaryCache(opId?: string): void {
  if (opId === undefined) cache.clear();
  else cache.delete(opId);
}
