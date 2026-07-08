/**
 * Relative-age formatting for memories surfaced into the model's context.
 *
 * Rationale (spec D5): a raw ISO timestamp does NOT reliably trigger
 * staleness reasoning in the model — it reads it as an opaque label. A RELATIVE
 * age ("47 days ago") does. So when a recalled memory snippet is rendered into
 * the prompt, we express its age relative to "now" instead of an absolute stamp.
 *
 * The timestamp callers should feed in is the chunk's DB `updated_at` (when
 * that snippet's content last changed) — NOT the source file's mtime, which
 * gets bumped wholesale by consolidation appends and doesn't exist at all for
 * virtual paths (session-live/…, import/…).
 *
 * Everything here is pure and deterministic: `now` is threaded in as a
 * parameter (never Date.now() inside the logic) so callers control the clock
 * and tests stay hermetic.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Memory content last changed more than ~1 day ago gets a caveat: any
 * file/line citations baked into it may point at code that has since moved.
 * A day is the coarse line between "this reflects the working tree I'm
 * looking at" and "this is a note from a prior state of the repo".
 */
export const STALE_MEMORY_THRESHOLD_MS = DAY_MS;

/**
 * Human-relative age, e.g. "just now", "3 hours ago", "47 days ago".
 * Clamps future timestamps (clock skew) to "just now".
 */
export function relativeAge(thenMs: number, nowMs: number): string {
  const diff = nowMs - thenMs;
  if (diff < MINUTE_MS) return "just now";

  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diff / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Caveat appended to a recalled memory older than the stale threshold, warning
 * that file/line references inside it may be outdated. Empty string for fresh
 * memories so the prompt stays clean.
 */
export function memoryStaleCaveat(thenMs: number, nowMs: number): string {
  return nowMs - thenMs > STALE_MEMORY_THRESHOLD_MS
    ? " (older memory — any file/line references inside may be outdated)"
    : "";
}
