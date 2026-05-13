/**
 * Session-level consent store for the threat engine's exfil bypass.
 *
 * Layer A's bypass (chat attachments + directive verbs) is *per-turn* —
 * it lives on the ToolChainAnalyzer instance that turn created. For
 * multi-turn workflows (user asks again on a later turn, or the model
 * needs to retry after a block) we need consent that persists across
 * turns within a session. This module is that store.
 *
 * Two writers:
 *   1. Layer A: chat entrypoint detects "attachment + directive verb"
 *      → grants consent for the session.
 *   2. Layer B: user explicitly types `/approve <reason>` → grants
 *      consent for the session.
 *
 * One reader:
 *   - chat entrypoint, before model call, checks the store and seeds
 *     the per-turn ThreatEngine if consent is still live.
 *
 * In-memory only — security state should be local, never synced.
 * Process restart wipes it (which is correct: a stale consent from
 * yesterday should NOT carry forward through a server reboot).
 */

interface ConsentEntry {
  until: number;
  reason: string;
  grantedAt: number;
}

const consents = new Map<string, ConsentEntry>();

export function grantConsent(sessionId: string, durationMs: number, reason: string): void {
  consents.set(sessionId, { until: Date.now() + durationMs, reason, grantedAt: Date.now() });
}

export function getActiveConsent(sessionId: string): { reason: string; remainingMs: number } | null {
  const c = consents.get(sessionId);
  if (!c) return null;
  const now = Date.now();
  if (now >= c.until) { consents.delete(sessionId); return null; }
  return { reason: c.reason, remainingMs: c.until - now };
}

export function clearConsent(sessionId: string): void {
  consents.delete(sessionId);
}

/** Test-only — drains the entire store. Never call in production code. */
export function _resetAllConsentForTests(): void {
  consents.clear();
}
