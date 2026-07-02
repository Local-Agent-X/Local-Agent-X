/**
 * A timeout that bounds ONLY a streaming request's connect / time-to-headers
 * phase — never the response body.
 *
 * `AbortSignal.timeout(ms)` keeps counting after the response starts, and when
 * passed to `fetch({ signal })` it aborts the whole request including the body
 * stream. For a streaming LLM call that means any generation longer than the
 * window is aborted mid-stream: a complete answer is truncated into an error
 * (Anthropic direct-API) or a partial answer silently stands as complete
 * (Codex). Long agentic turns hit this constantly.
 *
 * This composes a MANUAL timer with the caller's external cancel signal and
 * lets the caller `clear()` the timer the instant headers arrive. After that
 * only connect/first-byte was ever bounded; the streamed body remains abortable
 * by the external signal alone (barge-in / op-cancel still work).
 */
export interface ConnectTimeout {
  /** Pass to `fetch({ signal })`. */
  readonly signal: AbortSignal;
  /** Call once `fetch` resolves — stops the connect clock so it can no longer
   *  abort the streaming body. Idempotent. */
  clear(): void;
  /** True iff the connect timer fired (as opposed to the external cancel
   *  signal). Lets a retry loop treat a connect timeout as retryable while a
   *  user cancel stays terminal. */
  timedOut(): boolean;
}

export function connectTimeout(
  ms: number,
  external: AbortSignal | undefined,
  label: string,
): ConnectTimeout {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new Error(`${label} connect timeout (${Math.round(ms / 1000)}s)`));
  }, ms);

  const signals: AbortSignal[] = [controller.signal];
  if (external) signals.push(external);

  return {
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    clear: () => clearTimeout(timer),
    timedOut: () => fired,
  };
}
