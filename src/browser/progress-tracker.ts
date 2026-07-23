/**
 * No-progress detection for the browser tool.
 *
 * Replaces what the old count-based rate limit was crudely approximating: not
 * "too many calls" but "calls that go nowhere". We fingerprint the page after
 * each page-advancing action (click / click_text / act — the caller's
 * TRACKED_ACTIONS; reads and local edits like fill / select / scroll are not
 * tracked). When a session takes NO_PROGRESS_LIMIT consecutive such actions
 * whose fingerprint never changes, the page isn't responding to the agent — it's
 * stuck. The caller turns that into an isError result, which feeds the circuit
 * breaker (run-sandboxed records isError as a failure) and gives the agent a
 * clear "change approach" signal instead of silently looping.
 *
 * A productive session can never trip this: every click that changes the page
 * resets the counter.
 */

// Consecutive unchanged advancing actions before we call it stuck. Sized to
// give legitimate "click, nothing visibly moved, click again" retries slack
// while still catching a real spin quickly. This tracker is the ONLY
// browser-layer spin bound — there is no separate call-count ceiling.
const NO_PROGRESS_LIMIT = 6;

interface ProgressState {
  fingerprint: string;
  unchanged: number;
}

const sessions = new Map<string, ProgressState>();

export interface ProgressResult {
  stalled: boolean;
  unchanged: number;
}

/**
 * Record the page fingerprint after an advancing action. Returns whether the
 * session is now stuck. An empty fingerprint (page mid-transition / eval
 * failed) is treated as "unknown" and skipped — neither progress nor stall.
 */
export function recordProgress(sessionId: string, fingerprint: string): ProgressResult {
  if (!fingerprint) {
    const cur = sessions.get(sessionId);
    return { stalled: false, unchanged: cur?.unchanged ?? 0 };
  }
  const prev = sessions.get(sessionId);
  if (!prev || prev.fingerprint !== fingerprint) {
    sessions.set(sessionId, { fingerprint, unchanged: 0 });
    return { stalled: false, unchanged: 0 };
  }
  prev.unchanged += 1;
  return { stalled: prev.unchanged >= NO_PROGRESS_LIMIT, unchanged: prev.unchanged };
}

/** Clear a session's progress state (call on navigate / close). */
export function resetProgress(sessionId: string): void {
  sessions.delete(sessionId);
}

export { NO_PROGRESS_LIMIT };
