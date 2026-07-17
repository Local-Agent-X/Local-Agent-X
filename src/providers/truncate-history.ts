import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
// Pure constants module — safe as a static edge (unlike the summarizer, which
// stays a dynamic import so this early-loaded module never pulls in the
// context-manager/classifier stack).
import { CHAT_DIGEST_BUDGETS, chatHistoryMaxKeep } from "../context-manager/compaction-policy.js";

// Split out of providers/sanitize.ts (which stays the message-sanitization
// seam) so both files clear the 400-LOC gate. This module owns the working-
// window truncation + the CM-2 digest/summary of the truncated segment.

// ── CM-2: constraint-preserving auto-summary of the truncated segment ───────
//
// The digest below used to slice every old user message to a 150-char
// first-line snippet and drop tool results entirely, while the
// constraint-preserving LLM compactor (context-manager) had zero callers on
// the live chat path — a user constraint stated 45 messages back reached the
// model as a meaningless fragment. Two layers fix that:
//
//  1. The canonical LLM summarizer (`summarizeOldMessages` — the same
//     primitive the canonical loop's compact-history and /api/compact use) is
//     wired into this path. truncateHistory is sync and on the per-turn hot
//     path, so the call runs in the BACKGROUND: the result is cached per
//     old-segment prefix (hash-verified, so a stale or foreign entry can
//     never be misapplied) and folded into the digest from the next turn on.
//  2. The deterministic digest that covers whatever the LLM summary does not
//     yet cover (first truncated turn, the growth gap between refreshes, LLM
//     disabled/failed) preserves user turns verbatim up to head+tail bounds —
//     constraints cluster at the start and END of long specs — keeps a
//     bounded slice of assistant turns and tool results, and marks every
//     omission explicitly instead of dropping content silently.
// Clip/budget values are policy — context-manager/compaction-policy.ts owns
// them (CHAT_DIGEST_BUDGETS). Aliased locally to keep the digest code terse.
const {
  userKeepHead: USER_KEEP_HEAD,
  userKeepTail: USER_KEEP_TAIL,
  assistantMax: ASSISTANT_DIGEST_MAX,
  toolMax: TOOL_DIGEST_MAX,
  totalChars: DIGEST_CHAR_BUDGET,
  summaryRefreshMinGrowth: SUMMARY_REFRESH_MIN_GROWTH,
} = CHAT_DIGEST_BUDGETS;
// Cache eviction bound — mechanics, not budget policy; stays lane-local.
const SUMMARY_CACHE_MAX = 32;

interface OldSegmentSummary { covered: number; prefixHash: string; summary: string }
const summaryCache = new Map<string, OldSegmentSummary>();
const refreshInFlight = new Map<string, Promise<void>>();

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function messageFingerprint(m: ChatCompletionMessageParam): string {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  return `${m.role}:${c.length}:${c}`;
}

// Order-sensitive rolling hash over a message prefix. Used both as the cache
// key (hash of the segment's first message — stable per session, since the
// old segment only ever GROWS at its end) and as the verification that a
// cached summary really covers the current prefix before it is reused.
function hashMessages(msgs: ChatCompletionMessageParam[]): string {
  let acc = 0x811c9dc5;
  for (const m of msgs) acc = fnv1a(`${acc.toString(36)}|${messageFingerprint(m)}`);
  return `${acc.toString(36)}:${msgs.length}`;
}

function clipUserText(text: string): string {
  if (text.length <= USER_KEEP_HEAD + USER_KEEP_TAIL) return text;
  const omitted = text.length - USER_KEEP_HEAD - USER_KEEP_TAIL;
  return `${text.slice(0, USER_KEEP_HEAD)} … [${omitted} chars omitted] … ${text.slice(-USER_KEEP_TAIL)}`;
}

function digestLine(m: ChatCompletionMessageParam): string | null {
  if (m.role === "user" && typeof m.content === "string") {
    return `<prior_user>${clipUserText(m.content.replace(/\n/g, " "))}</prior_user>`;
  }
  if (m.role === "assistant" && typeof m.content === "string") {
    const flat = m.content.replace(/\s*\n\s*/g, " ").trim();
    if (!flat) return null; // tool-call-only turn; its tool_result line carries the info
    return `<prior_assistant>${flat.length > ASSISTANT_DIGEST_MAX ? `${flat.slice(0, ASSISTANT_DIGEST_MAX)}…` : flat}</prior_assistant>`;
  }
  if (m.role === "tool" && typeof m.content === "string") {
    const flat = m.content.replace(/\s*\n\s*/g, " ").trim();
    if (!flat) return null;
    return `<prior_tool_result>${flat.length > TOOL_DIGEST_MAX ? `${flat.slice(0, TOOL_DIGEST_MAX)}…` : flat}</prior_tool_result>`;
  }
  return null;
}

// Deterministic digest of a message run, newest-first under a total budget so
// a mega-session can never re-bloat the window truncation just reclaimed.
// Anything dropped is announced via an explicit omission marker (and gets
// covered by the next background LLM refresh).
function digestLines(msgs: ChatCompletionMessageParam[]): string[] {
  const lines: string[] = [];
  let used = 0;
  let omittedBefore = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = digestLine(msgs[i]);
    if (!line) continue;
    if (used + line.length > DIGEST_CHAR_BUDGET) { omittedBefore = i; break; }
    lines.push(line);
    used += line.length;
  }
  lines.reverse();
  if (omittedBefore >= 0) lines.unshift(`<prior_omitted count="${omittedBefore + 1}"/>`);
  return lines;
}

function scheduleSummaryRefresh(key: string, segment: ChatCompletionMessageParam[]): void {
  // Unit tests must never fire real background LLM calls (same guard as
  // soak-metrics.ts). The regression test clears these vars and mocks the
  // summarizer to exercise this path.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (refreshInFlight.has(key)) return;
  const snapshot = segment.slice();
  const task = (async () => {
    // Dynamic import: keeps providers/sanitize (pure, sync, imported early)
    // free of a static edge into the context-manager/classifier stack.
    const { summarizeOldMessages } = await import("../context-manager/compaction.js");
    const summary = await summarizeOldMessages(snapshot);
    if (!summary) return; // disabled / timed out / failed → deterministic digest keeps covering
    if (!summaryCache.has(key) && summaryCache.size >= SUMMARY_CACHE_MAX) {
      const oldest = summaryCache.keys().next().value;
      if (oldest !== undefined) summaryCache.delete(oldest);
    }
    summaryCache.set(key, { covered: snapshot.length, prefixHash: hashMessages(snapshot), summary });
  })();
  refreshInFlight.set(key, task.catch(() => {}).finally(() => { refreshInFlight.delete(key); }));
}

/** Await all in-flight background summary refreshes. For tests and graceful shutdown. */
export async function awaitPendingHistorySummaries(): Promise<void> {
  await Promise.allSettled([...refreshInFlight.values()]);
}

/**
 * Truncate a long history to a working window, with an optional summary header.
 * Cuts at the nearest user message so we never split a tool-call/tool-result pair.
 *
 * Preserves a leading `system` message verbatim (e.g. a compaction summary
 * from /api/compact). Without that special-case, truncate's own summary
 * loop ignores system rows and the explicit compaction content gets
 * silently dropped from `old` when a session grows past maxKeep
 * post-compaction.
 */
export function truncateHistory(
  messages: ChatCompletionMessageParam[],
  maxKeep: number = chatHistoryMaxKeep("default"),
): ChatCompletionMessageParam[] {
  let preservedLeader: ChatCompletionMessageParam | null = null;
  let body: ChatCompletionMessageParam[] = messages;
  if (body[0]?.role === "system") {
    preservedLeader = body[0];
    body = body.slice(1);
  }

  if (body.length <= maxKeep) {
    return preservedLeader ? [preservedLeader, ...body] : body;
  }

  const targetIdx = body.length - maxKeep;
  // Find nearest user message at or after target
  let cutIdx = targetIdx;
  for (let i = targetIdx; i < body.length; i++) {
    if (body[i].role === "user") { cutIdx = i; break; }
  }
  if (cutIdx >= body.length) {
    for (let i = targetIdx; i >= 0; i--) {
      if (body[i].role === "user") { cutIdx = i; break; }
    }
  }

  // Walk cutIdx backward if we'd split a tool_call/tool_result pair
  // (assistant with tool_calls must be followed by its tool results)
  if (cutIdx > 0 && body[cutIdx - 1]?.role === "assistant") {
    const prev = body[cutIdx - 1] as unknown as Record<string, unknown>;
    if (prev.tool_calls && Array.isArray(prev.tool_calls)) {
      // The assistant before the cut has tool_calls — include it and its
      // trailing tool_result rows. Backing cutIdx onto the assistant is
      // sufficient: recent = body.slice(cutIdx) captures the assistant AND
      // every following tool_result, so no explicit walk is needed.
      cutIdx = cutIdx - 1;
    }
  }
  // Also skip forward past any orphaned tool results at the start of recent
  while (cutIdx < body.length && body[cutIdx]?.role === "tool") {
    cutIdx++;
  }

  const old = body.slice(0, cutIdx);
  const recent = body.slice(cutIdx);

  // Summarize older messages so the model knows there was prior context.
  // CRITICAL: do NOT use "User: X / Agent: Y" format here — the model will
  // mimic that format in its OWN output and leak fake "User: ..." lines into
  // its replies. Wrap in XML tags instead (the system prompt already tells
  // the model XML-tagged blocks are reference context, not output to echo).
  //
  // Fold in the cached LLM summary for whatever prefix of `old` it covers
  // (hash-verified), render the uncovered remainder deterministically, and
  // schedule a background refresh once the uncovered gap is worth it.
  let covered = 0;
  let llmSummary = "";
  if (old.length > 0) {
    const key = hashMessages(old.slice(0, 1));
    const entry = summaryCache.get(key);
    if (entry && entry.covered <= old.length && hashMessages(old.slice(0, entry.covered)) === entry.prefixHash) {
      covered = entry.covered;
      llmSummary = entry.summary;
    }
    if (covered === 0 || old.length - covered >= SUMMARY_REFRESH_MIN_GROWTH) {
      scheduleSummaryRefresh(key, old);
    }
  }
  const summaryParts: string[] = [];
  if (llmSummary) summaryParts.push(`<prior_summary messages="${covered}">\n${llmSummary}\n</prior_summary>`);
  summaryParts.push(...digestLines(old.slice(covered)));
  const summary = `<prior_conversation count="${old.length}">\n${summaryParts.join("\n")}\n</prior_conversation>`;

  const autoSummary: ChatCompletionMessageParam = { role: "system", content: summary } as ChatCompletionMessageParam;
  return preservedLeader ? [preservedLeader, autoSummary, ...recent] : [autoSummary, ...recent];
}
