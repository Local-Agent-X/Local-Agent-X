import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { stripSystemInjectionTags } from "../sanitize.js";

/** Sanitize tool result content to remove pseudo-system injection tags. */
export function sanitizeToolResults(results: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return results.map(r => {
    if (r.role !== "tool" || typeof r.content !== "string") return r;
    return { ...r, content: stripSystemInjectionTags(r.content) };
  });
}

/**
 * Strip ephemeral self-check / quality-gate / middleware-nudge user messages
 * before persisting a session.
 *
 * Two filter mechanisms (defense-in-depth):
 *  1. Structural — `_ephemeral: true` flag set by agent-loop/run.ts on every
 *     middleware nudge push. New nudges are auto-filtered without anyone
 *     having to remember to update a string list.
 *  2. Legacy strings — covers nudges that were saved before the flag existed,
 *     plus self-check / quality-gate messages that aren't routed through the
 *     middleware nudge path.
 *
 * The model still sees the nudge during the turn (it's in the in-memory
 * messages array). The flag only kicks in at persist + replay boundaries so
 * the chat transcript on reload doesn't show purple "You claimed..." bubbles
 * where tool calls used to render live.
 */
export function stripEphemeralMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.filter((m) => {
    // Structural marker — set on every middleware nudge in agent-loop/run.ts
    if ((m as unknown as { _ephemeral?: boolean })._ephemeral === true) return false;

    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.startsWith("[Self-check]")) return false;
      if (m.content.startsWith("Your previous response was empty.")) return false;
      if (m.content.startsWith("Tool errors occurred but you did not address them.")) return false;
      if (m.content.startsWith("You do NOT need approval.")) return false;
      // Action-claim / force-tool-use nudges. Listed by exact prefix because
      // older sessions on disk pre-date the _ephemeral flag — those messages
      // need to be filtered on load too.
      if (m.content.startsWith("You claimed to have created or scheduled")) return false;
      if (m.content.startsWith("You claimed to have added/updated/created/scheduled")) return false;
      if (m.content.startsWith("You claimed an action ")) return false;
      // NOTE: "SYSTEM: You have called ..." loop nudges are kept — the LLM must see them to stop looping
    }
    // Strip legacy empty-response placeholders so they don't pollute
    // future turns (breaks alternating-role expectation on Codex API).
    if (m.role === "assistant" && typeof m.content === "string") {
      if (m.content.includes("model returned an empty response") && m.content.length < 300) return false;
    }
    return true;
  });
}

/**
 * Sanitize a message history before sending it to a provider.
 * Strips orphaned tool_calls (assistant tool_calls without matching tool results)
 * and orphaned tool results (tool messages without matching assistant calls).
 *
 * The OpenAI Responses API in particular silently rejects requests with
 * malformed tool_call structure — the model returns zero output items, which
 * shows up as an empty response. This is the root cause of the bridge handler
 * returning empty placeholders even for benign messages like "hey".
 */
export function sanitizeHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  type MsgRecord = Record<string, unknown>;
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      for (const tc of rec.tool_calls as Array<{ id: string }>) callIds.add(tc.id);
    }
    if (m.role === "tool" && rec.tool_call_id) {
      resultIds.add(rec.tool_call_id as string);
    }
  }
  const orphanedCallIds = new Set([...callIds].filter((id) => !resultIds.has(id)));

  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      if (orphanedCallIds.size > 0) {
        const cleaned = (rec.tool_calls as Array<{ id: string }>).filter((tc) => !orphanedCallIds.has(tc.id));
        if (cleaned.length === 0) {
          if (m.content) out.push({ role: m.role, content: m.content } as ChatCompletionMessageParam);
        } else {
          out.push({ ...m, tool_calls: cleaned } as typeof m);
        }
      } else {
        out.push(m);
      }
    } else if (m.role === "tool") {
      const tid = rec.tool_call_id as string | undefined;
      if (tid && callIds.has(tid) && !orphanedCallIds.has(tid)) {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }

  // Coalesce consecutive same-role text messages. Multiple bridge messages
  // arriving back-to-back with no agent reply (3x "hey") create runs of
  // user-only messages that violate the alternating-role expectation Codex
  // enforces and cause empty responses.
  const coalesced: ChatCompletionMessageParam[] = [];
  for (const m of out) {
    const last = coalesced[coalesced.length - 1];
    if (
      last &&
      last.role === m.role &&
      (m.role === "user" || m.role === "assistant") &&
      typeof last.content === "string" &&
      typeof m.content === "string" &&
      !(last as unknown as MsgRecord).tool_calls &&
      !(m as unknown as MsgRecord).tool_calls
    ) {
      // Merge into the previous message
      (last as { content: string }).content = `${last.content}\n${m.content}`;
      continue;
    }
    coalesced.push(m);
  }
  return coalesced;
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
// Build a chat turn's cleanHistory from raw session messages: sanitize
// provider-illegal shapes, then keep the most recent `maxKeep` (40 for web
// chat, 30 otherwise). Lives here next to its two building blocks so the resume
// path (run-chat-turn orchestrator, after a turn-lock replace) can rebuild
// cleanHistory from freshly-salvaged session.messages WITHOUT pulling in the
// heavy prepare-request pipeline. `prepared` snapshots history before the lock
// awaits the prior turn's salvage, so this refresh is what lets a same-instant
// "keep going" see the interrupted turn's work instead of re-deriving it.
export function buildCleanHistory(
  sessionMessages: ChatCompletionMessageParam[],
  channel: string,
  maxHistory?: number,
): ChatCompletionMessageParam[] {
  const maxKeep = maxHistory || (channel === "web" ? 40 : 30);
  return truncateHistory(sanitizeHistory(sessionMessages), maxKeep);
}

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
const USER_KEEP_HEAD = 2000;
const USER_KEEP_TAIL = 1000;
const ASSISTANT_DIGEST_MAX = 300;
const TOOL_DIGEST_MAX = 200;
// Total budget for the deterministic digest, spent newest-first (older turns
// are likelier superseded AND likelier already covered by the LLM summary).
const DIGEST_CHAR_BUDGET = 24_000;
// Don't re-summarize on every turn — refresh once the uncovered gap has grown
// past this many messages. Between refreshes the gap is rendered by the
// deterministic digest above.
const SUMMARY_REFRESH_MIN_GROWTH = 10;
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

export function truncateHistory(messages: ChatCompletionMessageParam[], maxKeep: number = 30): ChatCompletionMessageParam[] {
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
