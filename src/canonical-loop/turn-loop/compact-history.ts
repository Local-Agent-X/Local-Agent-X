// Ephemeral context-window compaction for the canonical loop. The loop replays
// full op_messages every turn; on a long op that eventually overruns the model's
// window. This reshapes the per-turn message view (NEVER op_messages on disk):
// when usage crosses the provider-aware threshold, older turns are replaced by an
// LLM summary and only the recent turns are kept verbatim.
//
// Policy (thresholds, window table, the summarizer) is the canonical
// context-manager subsystem; this module is the CanonicalMessage adapter +
// tool-pairing-safe splitter. A no-op under threshold (the common path), so it
// only pays the summarization cost when actually near the window.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CanonicalMessage } from "../contract-types.js";
import type { LastTurnUsage } from "../op-usage.js";
import { getContextStatus } from "../../context-manager/status.js";
import { turnCompactionKeepLast } from "../../context-manager/compaction-policy.js";
import { resolveAnthropicTransport } from "../../context-manager/resolve-transport.js";
import type { TokenAnchor } from "../../context-manager/token-estimation.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import { clearSummaryCache, reusableSummary, storeSummary } from "./compact-summary-cache.js";
import {
  breakerGate,
  consumeForcedCompaction,
  recordBreakerFailure,
  recordBreakerSuccess,
} from "./compact-breaker.js";
import { opMessageRowToChatParam } from "../chat-runner/message-convert.js";
import { extractText, extractToolResultText } from "./content-extract.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.compact-history");

// Project canonical rows to the OpenAI-ish shape the context-manager helpers
// read. Lossy by design, but never EMPTY: token counting and the summarizer
// transcript must see tool payloads or a tool-heavy op under-counts and never
// compacts. tool_result payloads live under `content.result` (dispatch-tools.ts)
// and assistant tool calls under `content.toolCalls` (seed-messages.ts) — both
// are surfaced here. tool_result/control collapse to user text so we never need
// a tool_call_id; this projection is never sent to a provider.
export function toChatParams(messages: CanonicalMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "system": return { role: "system", content: extractText(m.content) };
      case "assistant": return { role: "assistant", content: assistantText(m.content) };
      case "tool_result": return { role: "user", content: `[tool result] ${extractToolResultText(m.content)}` };
      default: return { role: "user", content: extractText(m.content) }; // user + control
    }
  });
}

// Assistant rows carry their tool invocations under `content.toolCalls`; the
// plain text alone blanks a tool-only turn. Append a compact one-line-per-call
// marker so the estimator and summarizer SEE the calls (lossy but non-empty).
function assistantText(content: unknown): string {
  const text = extractText(content);
  const calls =
    content && typeof content === "object"
      ? (content as { toolCalls?: unknown }).toolCalls
      : undefined;
  if (!Array.isArray(calls) || calls.length === 0) return text;
  const markers = calls
    .map((c) => {
      const call = (c ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof call.name === "string" ? call.name : "tool";
      const args = typeof call.arguments === "string" ? call.arguments : "";
      const short = args.length > 200 ? `${args.slice(0, 200)}…` : args;
      return `[called ${name}(${short})]`;
    })
    .join("\n");
  return text ? `${text}\n${markers}` : markers;
}

// Index at which the kept-verbatim tail begins, chosen at a TURN boundary so a
// tool cycle (assistant tool_use → tool_result) is never split — splitting one
// orphans the tool_result and the provider rejects the turn. The tail must never
// START on a `tool_result` (its assistant tool_use would be stranded in the
// summarized head) nor on a mid-cycle `control` row. Both a `user` row and an
// `assistant` row are safe turn-starts: an assistant's tool_results always come
// AFTER it, so splitting on the assistant keeps the pair together. We walk back
// only OFF tool_result/control rows onto the nearest such turn-start — NOT all
// the way to a `user` row, which on a long single-user op is the lone seed at
// index 0, collapsing compaction to a no-op (the very bug this exists to fix).
// Returns 0 when there's nothing safe to compact (caller leaves history intact).
export function safeSplitIndex(messages: CanonicalMessage[], keepLast: number): number {
  if (messages.length <= keepLast + 2) return 0;
  let idx = messages.length - keepLast;
  while (idx > 0 && (messages[idx].role === "tool_result" || messages[idx].role === "control")) idx--;
  return idx;
}

// Map a real-usage reading (from op_turns) onto the current message view: find
// the first row appended AFTER the anchoring response, so everything before it
// is covered by the provider's own token count and only the tail is estimated.
// Rows are ordered by (turnIdx, seqInTurn); within the anchor turn the response
// is the assistant row, so post-response rows are everything after it. A
// tool-only turn finalizes NO assistant row — there its tool_results (and
// anything appended after them, e.g. nudges) are the post-response tail.
// Honesty rule: if the view can't be mapped reliably — a row without turnIdx
// (synthetic/reshaped view), a compaction summary row, or rows that don't
// cleanly split around the anchor turn — return null and let the caller use
// the pure estimate for the whole view. Never guess a slice point.
export function locateAnchor(
  messages: CanonicalMessage[],
  usage: LastTurnUsage,
): TokenAnchor | null {
  for (const m of messages) {
    if (typeof m.turnIdx !== "number") return null;
    if (m.messageId.startsWith("compact-summary-")) return null;
  }

  let lastAssistant = -1; // last assistant row of the anchor turn (the response)
  let firstToolResult = -1; // first tool_result of the anchor turn (tool-only turns)
  let firstLater = messages.length; // first row of any later turn
  for (let i = 0; i < messages.length; i++) {
    const t = messages[i].turnIdx as number;
    if (t === usage.turnIdx) {
      if (messages[i].role === "assistant") lastAssistant = i;
      if (messages[i].role === "tool_result" && firstToolResult === -1) firstToolResult = i;
    } else if (t > usage.turnIdx && i < firstLater) {
      firstLater = i;
    }
  }

  let estimateFrom: number;
  if (lastAssistant >= 0) estimateFrom = lastAssistant + 1;
  else if (firstToolResult >= 0) estimateFrom = firstToolResult;
  else estimateFrom = firstLater;

  // The anchored/estimated split must be a clean suffix: no later-turn row
  // before it, no earlier-turn row after it. Anything else means the view was
  // reordered or collapsed across the boundary — not mappable.
  for (let i = 0; i < messages.length; i++) {
    const t = messages[i].turnIdx as number;
    if (i < estimateFrom && t > usage.turnIdx) return null;
    if (i >= estimateFrom && t < usage.turnIdx) return null;
  }

  return { anchorTokens: usage.contextTokens, estimateFrom };
}

// The compaction circuit breaker and the forced-compaction marker live in
// compact-breaker.ts (file-size gate); re-exported so callers keep importing
// them from here.
export { forceCompactNext, compactionBreakerState } from "./compact-breaker.js";

export interface CompactHistoryResult {
  messages: CanonicalMessage[];
  /**
   * True only when the view was actually RESHAPED (summary swapped in). The
   * caller stamps this onto the committed provider_state so the next turn
   * knows this turn's recorded usage describes the compacted view — anchoring
   * on it against the full replay would freeze compaction one turn later.
   */
  compacted: boolean;
}

export async function compactHistory(
  messages: CanonicalMessage[],
  model: string,
  // Real usage of the op's last recorded turn (op-usage.ts lastTurnUsage).
  // Absent/unmappable → pure estimate, the historical behavior.
  usage?: LastTurnUsage | null,
  // Threads the circuit breaker (above). Absent → breaker bypassed.
  opId?: string,
  // Baseline token cost (system prompt + tool manifest + memory) the adapter
  // sends outside `messages`. Added to the estimate when there is no anchor, so
  // chat sizing accounts for the ~147k the pure estimate can't see. 0 → off.
  baselineTokens = 0,
  // recall confines reads to the caller's session; on a session-less op the
  // recall HINT line is suppressed (the range citation itself still lands).
  sessionBacked = true,
): Promise<CompactHistoryResult> {
  // Consume the overflow-recovery marker (set once per provider overflow), then
  // the breaker gate: while tripped it short-circuits, except on every
  // PROBE_INTERVAL-th call (a recovery probe) and when forced.
  const forced = consumeForcedCompaction(opId);
  const gate = breakerGate(opId, forced);
  if (gate.skip) return { messages, compacted: false };
  const usageAnchor = usage ? locateAnchor(messages, usage) : null;
  if (usage && !usageAnchor) {
    logger.debug(`anchor at turn ${usage.turnIdx} not mappable onto the current view; sizing by pure estimate`);
  }
  const status = getContextStatus(toChatParams(messages), model, usageAnchor ?? undefined, resolveAnthropicTransport(), baselineTokens);
  if (!forced && !status.shouldCompact) return { messages, compacted: false };

  // Keep tiers (incl. the forced/overflow aggressive minimum) are policy —
  // context-manager/compaction-policy.ts owns the values.
  const keepLast = turnCompactionKeepLast(status.percentage, forced);

  const splitIdx = safeSplitIndex(messages, keepLast);
  if (splitIdx <= 0) return { messages, compacted: false };

  // Summary STABILITY (compact-summary-cache.ts): the view is never persisted,
  // so an over-threshold op compacts every turn and splitIdx advances every
  // turn. Re-summarizing each time rewrites message index 0 each time, which
  // destroys the cache prefix AND burns a summarizer call per turn. A reusable
  // entry PINS the boundary at the head it covers — the rows between there and
  // splitIdx just stay verbatim — so index 0 is byte-identical until the head
  // has grown past TURN_SUMMARY_REFRESH_MIN_GROWTH. Callers without an opId
  // (direct/test) are stateless as before.
  // NEVER reuse on a forced pass. `forced` means the provider already rejected
  // this conversation as over-window (adapter-throw-recovery.ts), and the retry
  // deliberately appends nothing — so a pinned boundary would rebuild the exact
  // view that just overflowed, the aggressive keep tier would be discarded, and
  // the retry cap would exhaust on identical payloads. Drop the entry too, so the
  // next turn re-pins from the smaller head instead of restoring the old one.
  if (forced && opId) clearSummaryCache(opId);
  const reuse = opId && !forced ? reusableSummary(opId, messages, splitIdx) : null;
  const summarizedCount = reuse ? reuse.covered : splitIdx;
  const head = messages.slice(0, summarizedCount);
  const recent = messages.slice(summarizedCount);

  const summary = reuse ? reuse.summary : await summarizeOldMessages(toChatParams(head));
  // Disabled (LAX_LLM_COMPACTION), timed out, or failed: keep the full history
  // rather than silently truncating. An over-window call surfaces as a provider
  // error, which is honest; a silent drop corrupts the conversation.
  //
  // summarizeOldMessages can't tell us WHY it returned null, so the kill-switch
  // exclusion reads the env at the counting site (same check classify-with-llm.ts
  // makes): disabled-by-switch is intentional, not a failed attempt.
  if (!summary) {
    if (opId && process.env.LAX_LLM_COMPACTION !== "0") recordBreakerFailure(opId);
    return { messages, compacted: false };
  }
  // Successful compaction resets the consecutive-failure count. When the op was
  // tripped this is a probe recovering — surface that once at info.
  if (opId) {
    recordBreakerSuccess(opId, gate.tripped);
    if (!reuse) storeSummary(opId, messages, summarizedCount, summary);
  }

  const anchor = recent[0];
  // Replaced-span range pointer. head rows always come from the raw op_messages
  // replay (build-input.ts rebuilds the view from readOpMessages every turn and
  // never persists the compacted view), so they are never prior compact-summary
  // rows. The `firstId:lastId` format is recall-tool's parseCursor range shape.
  const range = recallRange(head);
  const rangeTag = range ? `, range ${range.firstId}:${range.lastId}` : "";
  const hint = range && sessionBacked
    ? `[Full original messages retrievable via the recall tool with cursor="${range.firstId}:${range.lastId}"]\n`
    : "";
  const block =
    `[Earlier conversation auto-summarized to save context — ${head.length} messages${rangeTag}]\n` +
    `${summary}\n` +
    hint +
    `[End of summary. Your most recent messages follow.]`;

  // Fold the summary into a USER boundary row (no extra message → no adjacent-
  // user rejection, mirrors the situational-awareness digest). But when the tail
  // begins on an ASSISTANT turn-start (the long single-user op, where the head we
  // dropped held the only seed user row), we must NOT overwrite that row: doing
  // so strips its tool_calls and orphans the tool_result that follows. Prepend a
  // standalone user summary row instead — user→assistant is a valid opener and
  // restores the "first message is user" invariant that dropping the seed breaks.
  if (anchor.role === "user") {
    const merged = `${block}\n\n${extractText(anchor.content)}`;
    const mergedAnchor: CanonicalMessage = {
      ...anchor,
      content: hasImages(anchor.content)
        ? { ...(anchor.content as Record<string, unknown>), text: merged, ...(range && { summaryRange: range }) }
        : { text: merged, ...(range && { summaryRange: range }) },
    };
    return { messages: [mergedAnchor, ...recent.slice(1)], compacted: true };
  }
  const summaryRow: CanonicalMessage = {
    messageId: `compact-summary-${anchor.messageId}`,
    role: "user",
    content: { text: block, ...(range && { summaryRange: range }) },
  };
  return { messages: [summaryRow, ...recent], compacted: true };
}

// Nearest head rows that SURVIVE recall's projection — recall pages only rows
// opMessageRowToChatParam keeps (called here directly so this never drifts):
// nudges/control/empty rows are dropped, an unresolvable startId errors, and an
// unresolvable endId silently widens the range to end-of-transcript, so a
// dropped boundary row would emit a broken cursor. Null when nothing survives.
function recallRange(head: CanonicalMessage[]): { firstId: string; lastId: string } | null {
  const survives = (m: CanonicalMessage): boolean =>
    opMessageRowToChatParam({
      messageId: m.messageId,
      opId: "",
      turnIdx: m.turnIdx ?? 0,
      seqInTurn: m.seqInTurn ?? 0,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt ?? "",
    }) !== null;
  let first = -1;
  for (let i = 0; i < head.length; i++) if (survives(head[i])) { first = i; break; }
  if (first === -1) return null;
  let last = head.length - 1;
  while (last > first && !survives(head[last])) last--;
  return { firstId: head[first].messageId, lastId: head[last].messageId };
}

function hasImages(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    Array.isArray((content as { images?: unknown }).images) &&
    (content as { images: unknown[] }).images.length > 0
  );
}
