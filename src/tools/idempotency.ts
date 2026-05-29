// Cross-session destructive-tool idempotency. Different from the
// within-op dedup phase in src/tool-execution/dedup-cache.ts:
//
//   - Axis 2 (dedup-cache):  scope = session/run, TTL = 60s, generic
//                            backstop wired into the tool-execution
//                            pipeline. Catches the MCP-loop class.
//   - Axis 3 (this module):  scope = global (process-local), TTL =
//                            minutes-to-hours, per-tool natural-key
//                            fingerprint. Catches "user retried 5 min
//                            later" / "different session same payload"
//                            duplicate sends.
//
// Both layers are intentional: Axis 2 fires before tool execution and
// returns the prior result; Axis 3 fires from INSIDE the tool's execute()
// and surfaces a "skipped — already done at <time>" message so the model
// understands it's a deliberate no-op, not a failure. Email_send and the
// social posts call this; the inert-side-effect tools rely on Axis 2.

import { createHash } from "node:crypto";

interface Entry {
  ts: number;
  result: string;
}

const store = new Map<string, Entry>();

function key(toolName: string, fingerprint: string): string {
  return createHash("sha256")
    .update(`${toolName}|${fingerprint}`)
    .digest("hex")
    .slice(0, 24);
}

function gc(now: number): void {
  // Cap the store by sweeping anything past the widest realistic window.
  // 24h is well past the longest per-tool window and bounds memory under
  // adversarial input.
  const SWEEP_MS = 24 * 60 * 60 * 1000;
  for (const [k, v] of store) {
    if (now - v.ts > SWEEP_MS) store.delete(k);
  }
}

/** Look up whether (toolName, fingerprint) has been recorded within the
 *  caller's window. Returns the prior result string + the age in ms on
 *  hit, null on miss. */
export function recentlyDone(
  toolName: string,
  fingerprint: string,
  windowMs: number,
): { result: string; ageMs: number } | null {
  const now = Date.now();
  gc(now);
  const entry = store.get(key(toolName, fingerprint));
  if (!entry) return null;
  const ageMs = now - entry.ts;
  if (ageMs >= windowMs) return null;
  return { result: entry.result, ageMs };
}

/** Record a completed destructive call. Caller must only invoke AFTER
 *  the side effect actually happened (e.g. after `transport.sendMail`
 *  resolves successfully) so a failed attempt doesn't block legitimate
 *  retry. */
export function markDone(toolName: string, fingerprint: string, result: string): void {
  store.set(key(toolName, fingerprint), { ts: Date.now(), result });
}

/** Build a stable fingerprint from arbitrary string parts. Empty parts
 *  collapse to "" so callers don't have to filter; whitespace at the
 *  edges is trimmed. */
export function fingerprintOf(...parts: string[]): string {
  const normalized = parts.map(p => (p ?? "").trim()).join("");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Format a "how long ago" string for the duplicate-skipped message. */
export function describeAge(ageMs: number): string {
  if (ageMs < 1000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} min ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}

/** Test-only: drop the entire store. */
export function _clearIdempotencyStoreForTests(): void {
  store.clear();
}
