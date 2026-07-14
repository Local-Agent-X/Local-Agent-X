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

// ─── Compaction circuit breaker ──────────────────────────────────────────────
// A session whose context is irrecoverably over the summarizer's own limits
// fails the summarize call every turn, forever — each retry burns up to two
// 30s LLM calls for nothing (the rewrite guard may retry a degenerate output). After TRIP_THRESHOLD consecutive failed attempts for an op
// the breaker trips and compactHistory skips the attempt on later calls — but
// not forever: a transient provider outage must not disable summarization for
// a long-lived op's whole life. While tripped, every PROBE_INTERVAL-th
// otherwise-skipped call runs the normal full path once as a recovery probe.
// A probe whose summarize attempt succeeds fully resets the breaker (entry
// deleted — a later failure streak needs TRIP_THRESHOLD fresh failures to
// re-trip); an enabled-null re-trips immediately (no 3-strike grace, no
// re-logged error — debug only) and starts the next skip window. Any
// successful compaction resets the count.
//
// What counts as a FAILED attempt: we decided to compact (over threshold, safe
// split point) and summarizeOldMessages returned null WHILE ENABLED. The
// LAX_LLM_COMPACTION=0 kill switch (classify-with-llm.ts) is an intentional
// off-switch, not an error loop — it never counts. A structural no-op (under
// threshold, or no safe split) never touches the counter either way.
//
// State is per-op, in-memory, bounded (mirrors memory/extraction-coalescer.ts):
// cap entries, evict the oldest-touched when full. Callers without an opId
// (direct/test callers) bypass the breaker entirely — stateless as before.

const TRIP_THRESHOLD = 3;
// While tripped, every PROBE_INTERVAL-th otherwise-skipped call re-attempts.
const PROBE_INTERVAL = 10;
const MAX_TRACKED_OPS = 500;

interface BreakerEntry {
  failures: number;
  tripped: boolean;
  /** Calls short-circuited since the trip (or since the last consumed probe). */
  skipsSinceTrip: number;
  touchedAt: number;
}

const breakers = new Map<string, BreakerEntry>();

function getBreaker(opId: string): BreakerEntry {
  let b = breakers.get(opId);
  if (!b) {
    if (breakers.size >= MAX_TRACKED_OPS) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, e] of breakers) {
        if (e.touchedAt < oldestAt) { oldestAt = e.touchedAt; oldestKey = key; }
      }
      if (oldestKey !== undefined) breakers.delete(oldestKey);
    }
    b = { failures: 0, tripped: false, skipsSinceTrip: 0, touchedAt: Date.now() };
    breakers.set(opId, b);
  }
  b.touchedAt = Date.now();
  return b;
}

function recordBreakerFailure(opId: string): void {
  const b = getBreaker(opId);
  b.failures += 1;
  if (b.tripped) {
    // A recovery probe failed: stay tripped and start the next skip window
    // immediately — no 3-strike grace. The trip was already surfaced at error
    // once; probes stay quiet.
    b.skipsSinceTrip = 0;
    logger.debug(`compaction breaker probe failed for op ${opId}; staying tripped`);
    return;
  }
  if (b.failures >= TRIP_THRESHOLD) {
    b.tripped = true;
    // Surface the error state honestly, ONCE, at trip time. Later skips log at
    // debug only — the state is readable via compactionBreakerState().
    // A null from summarizeOldMessages doesn't distinguish a summarize FAILURE
    // (provider error, timeout) from summarization being UNAVAILABLE (no provider
    // configured — classify-with-llm returns null fast when
    // resolveProviderContext() is null), so the message covers both.
    logger.error(
      `compaction circuit breaker tripped for op ${opId} after ${b.failures} consecutive ` +
      `summarize attempts returned nothing — summarization unavailable or failing ` +
      `(provider error, timeout, or no provider configured). Compaction now skips, ` +
      `re-probing every ${PROBE_INTERVAL}th call; context stays unsummarized ` +
      `meanwhile — over-window provider errors may follow.`,
    );
  }
}

// ─── Forced compaction (overflow recovery) ───────────────────────────────────
// When the PROVIDER rejects a call as over-window (context_overflow /
// payload-too-large), the threshold estimate demonstrably undershot — the next
// build-input must compact regardless of what the estimate says. The overflow
// recovery (adapter-throw-recovery.ts) sets this marker; compactHistory
// consumes it once: threshold check bypassed, aggressive keep, and the breaker
// skip is overridden (the provider error IS the probe signal).
const forcedOps = new Set<string>();

export function forceCompactNext(opId: string): void {
  forcedOps.add(opId);
}

/** Readonly view of an op's breaker state, for telemetry/doctor. */
export function compactionBreakerState(
  opId: string,
): Readonly<{ failures: number; tripped: boolean; skipsSinceTrip: number }> | undefined {
  const b = breakers.get(opId);
  return b
    ? { failures: b.failures, tripped: b.tripped, skipsSinceTrip: b.skipsSinceTrip }
    : undefined;
}

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
): Promise<CompactHistoryResult> {
  // Consume the overflow-recovery marker (set once per provider overflow).
  const forced = opId ? forcedOps.delete(opId) : false;
  const breaker = opId ? breakers.get(opId) : undefined;
  if (breaker?.tripped && !forced) {
    breaker.touchedAt = Date.now();
    if (breaker.skipsSinceTrip + 1 < PROBE_INTERVAL) {
      breaker.skipsSinceTrip += 1;
      logger.debug(`compaction breaker open for op ${opId}; skipping summarize attempt`);
      return { messages, compacted: false };
    }
    // Every PROBE_INTERVAL-th otherwise-skipped call falls through as a recovery
    // probe. The probe window is consumed only where a summarize attempt actually
    // resolves (a probe failure resets skipsSinceTrip; a success deletes the
    // entry): a probe that turns out structurally unneeded (under threshold, no
    // safe split) or kill-switch-disabled leaves the counter parked one shy of
    // the interval, so the NEXT eligible call probes instead of waiting out a
    // fresh window — the probe only counts once summarize actually ran.
    logger.debug(`compaction breaker probing for op ${opId} after ${breaker.skipsSinceTrip} skipped calls`);
  }
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

  const head = messages.slice(0, splitIdx);
  const recent = messages.slice(splitIdx);

  const summary = await summarizeOldMessages(toChatParams(head));
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
    if (breaker?.tripped) {
      logger.info(`compaction summarization recovered for op ${opId}; circuit breaker reset`);
    }
    breakers.delete(opId);
  }

  const anchor = recent[0];
  const block =
    `[Earlier conversation auto-summarized to save context — ${head.length} messages]\n` +
    `${summary}\n` +
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
        ? { ...(anchor.content as Record<string, unknown>), text: merged }
        : { text: merged },
    };
    return { messages: [mergedAnchor, ...recent.slice(1)], compacted: true };
  }
  const summaryRow: CanonicalMessage = {
    messageId: `compact-summary-${anchor.messageId}`,
    role: "user",
    content: { text: block },
  };
  return { messages: [summaryRow, ...recent], compacted: true };
}

function hasImages(content: unknown): boolean {
  return (
    !!content &&
    typeof content === "object" &&
    Array.isArray((content as { images?: unknown }).images) &&
    (content as { images: unknown[] }).images.length > 0
  );
}
