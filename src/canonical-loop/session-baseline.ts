/**
 * Session-level REAL baseline: the stable per-request overhead (system prompt +
 * tool schemas + injected memory + the `claude` subprocess's OWN system/MCP
 * wrapping) that the adapter sends OUTSIDE the message array, so it never
 * appears in the token estimate.
 *
 * Why the estimate can't see it: each chat message is a fresh op whose turn 0
 * has no within-op anchor, so compaction sizes by pure estimate of the messages
 * only. A string estimate of our own system prompt + tools misses the CLI
 * subprocess half entirely — live measurement: a 2-token message's real prefix
 * was ~119k while the string estimate was ~56k (a 2x under-count, the DANGEROUS
 * direction → over-window send → "prompt is too long").
 *
 * The only signal that includes the subprocess half is REAL usage. This module
 * observes it at turn-commit and caches it per session, so sizing is O(1) (no
 * per-turn store scan) and staleness-proof (the cached value is the stable
 * baseline, added to the FULL current conversation estimate — not a prior
 * conversation snapshot).
 *
 * Soundness (vs the refuted prior design):
 *  - Measured ONLY from clean tool-LESS turns. CLI tool turns report usage
 *    summed across in-stream iterations (op-usage.ts's C1 evidence), so their
 *    prefix is a cumulative over-count — skipped, never poisoning the cache.
 *  - Keeps the observation from the SMALLEST-conversation clean turn: its
 *    estimate error (real vs estimated conversation) is least, so the isolated
 *    baseline is closest to the pure ~119k.
 *  - Added to the full current-conversation estimate, so it stays correct no
 *    matter how much conversation has accrued since the observation.
 *  - Scoped to "chat_turn" ops (see recordSessionBaselineObservation): the
 *    baseline is constant only within one op class's tool surface, and a
 *    delegated op sharing the session must not pull it toward its narrower
 *    surface.
 *
 * Accepted residual: recalled memory injected into the system prompt varies per
 * message, so the baseline isn't perfectly constant even within a chat session.
 * min-conv locks in the smallest-conversation turn's memory footprint; a later
 * heavier-memory message under-counts by that delta (a few k), which the 25%
 * gap between the 75% compact threshold and the 100% hard limit absorbs.
 */
import type { ProviderStateEnvelope } from "./types.js";
import type { CanonicalMessage } from "./contract-types.js";
import { ANTHROPIC_ADAPTER_NAME } from "./adapters/anthropic/types.js";
import { effectiveContextWindow } from "../context-manager/effective-window.js";
import { resolveAnthropicTransport } from "../context-manager/resolve-transport.js";
import { totalTokens } from "../context-manager/token-estimation.js";
import { toChatParams } from "./turn-loop/compact-history.js";

interface Observation {
  /** Isolated stable baseline: real prompt prefix − estimated prompt conversation. */
  baseline: number;
  /** Estimated conversation of the observed turn; smaller = more accurate baseline. */
  convTokens: number;
}

const MAX_SESSIONS = 500;
const sessions = new Map<string, Observation>();

/**
 * Record a committed turn as a candidate baseline observation. No-op unless the
 * turn is a clean Anthropic tool-less non-compacted turn with plausible usage.
 * Keeps, per session, the observation from the smallest-conversation such turn.
 *
 * `promptMessages` is the conversation the turn's request carried (the op's
 * messages BEFORE this turn's output was appended) — its estimate is subtracted
 * from the real prefix to isolate the conversation-independent baseline.
 */
export function recordSessionBaselineObservation(
  sessionId: string | undefined | null,
  opType: string,
  providerState: ProviderStateEnvelope | undefined,
  observedTools: string[] | undefined,
  promptMessages: CanonicalMessage[],
): void {
  if (!sessionId) return;
  // Scope to genuine chat ops. Delegated/submitted ops inherit the parent chat
  // sessionId but carry a DIFFERENT tool surface (narrower → smaller real
  // baseline); letting them observe would let min-conv-wins clobber the chat
  // baseline downward → under-count → the death this exists to prevent. The
  // baseline is constant only WITHIN one op class's tool surface, and
  // "chat_turn" is the full interactive-chat surface the death occurs on.
  if (opType !== "chat_turn") return;
  const obs = observe(providerState, observedTools, promptMessages);
  if (!obs) return;
  const existing = sessions.get(sessionId);
  if (existing && existing.convTokens <= obs.convTokens) return; // keep the tighter (smaller-conv) one
  sessions.delete(sessionId); // re-insert to refresh LRU position
  sessions.set(sessionId, obs);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
}

/** The observed stable baseline for a session, or null if none recorded yet. */
export function getSessionBaselineTokens(sessionId: string | undefined | null): number | null {
  if (!sessionId) return null;
  return sessions.get(sessionId)?.baseline ?? null;
}

/** Test seam. */
export function resetSessionBaselines(): void {
  sessions.clear();
}

function observe(
  ps: ProviderStateEnvelope | undefined,
  observedTools: string[] | undefined,
  promptMessages: CanonicalMessage[],
): Observation | null {
  if (!ps) return null;
  if (ps.adapterName !== ANTHROPIC_ADAPTER_NAME) return null;       // OpenAI-style usage differs
  if (typeof ps.viewCompacted !== "boolean" || ps.viewCompacted) return null; // pre-marker / compacted view
  if ((observedTools?.length ?? 0) > 0) return null;               // tool turn → cumulative usage, unreliable
  const payload = ps.providerPayload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const input = payload.usageInputTokens;
  const cacheRead = payload.cacheReadTokens;
  const cacheCreate = payload.cacheCreateTokens;
  if (typeof input !== "number" || typeof cacheRead !== "number" || typeof cacheCreate !== "number") return null; // absent ≠ 0
  const prefix = input + cacheRead + cacheCreate; // the request PROMPT (excludes output)
  if (prefix <= 0) return null;
  const model = payload.model;
  if (typeof model !== "string" || model.length === 0) return null;
  if (prefix > effectiveContextWindow(model, resolveAnthropicTransport())) return null; // implausible → refuse
  const convTokens = totalTokens(toChatParams(promptMessages));
  return { baseline: Math.max(0, prefix - convTokens), convTokens };
}
