/**
 * Content-safe provider retry — the missing resilience seam on the per-turn
 * model call.
 *
 * Every provider transport (anthropic / openai-compat / codex / gemini) yields
 * an `error` TransportEvent on a 429 / 5xx / network drop and then `done`,
 * with `retryable` HARDCODED to `false`. The canonical loop turns that single
 * error into a terminal `terminalReason:"error"` → op `failed`. So one
 * transient blip — exactly the failure providers throw routinely under load —
 * kills the whole turn and loses work, with no backoff and no retry.
 *
 * `withTransportRetry` wraps a transport stream factory and re-issues the
 * request on transient failures, with three invariants that make it safe:
 *
 *   1. CONTENT-SAFE — it retries ONLY while no content (text / tool_call /
 *      thinking) has been yielded yet. Once the consumer has seen output, a
 *      failure is surfaced, never retried, so streamed text is never
 *      double-emitted. This mirrors how the official provider SDKs retry the
 *      initial request but never a partially-consumed stream body.
 *   2. TRANSIENT-ONLY — retryability + backoff come from `resilience-policy`
 *      (the existing single seam): network / timeout / rateLimit / overload
 *      retry; auth / model / tool / contentFilter do not (retrying won't help).
 *      The transports' hardcoded `retryable:false` is NOT trusted — only an
 *      explicit `true` is a fast-path; otherwise the error message is classified.
 *   3. BOUNDED + ABORTABLE — at most `maxAttempts` total tries, and both the
 *      retry decision and the backoff sleep bail the moment the turn is aborted
 *      (user cancel / inject), so a cancelled turn never sits in backoff.
 *
 * Re-issuing a failed LLM request is idempotent — it has no machine
 * side-effects (unlike a `bash`/`edit` retry), so this is the one retry the
 * per-turn path was missing.
 */
import { classify, isRetryable, backoffMs, type ErrorCategory } from "../../resilience-policy.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.transport-retry");

/** Default total attempts (1 initial + up to N-1 retries). Override with
 * LAX_LLM_RETRY_ATTEMPTS for the rare operator who wants it tighter/off (1). */
const DEFAULT_MAX_ATTEMPTS = (() => {
  const raw = process.env.LAX_LLM_RETRY_ATTEMPTS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
})();
const MAX_TRANSPORT_ATTEMPTS = 3;

interface ErrorLike {
  type: string;
  message?: string;
  code?: string;
  retryable?: boolean;
}

export interface TransportRetryOpts {
  /** Provider label for logs, e.g. "anthropic". */
  label: string;
  /** Abort signal — stops retries and cuts the backoff sleep short. */
  signal?: AbortSignal;
  /** Secondary abort probe for transports that expose a flag, not a signal. */
  isAborted?: () => boolean;
  /** Max total attempts (default 3 → up to 2 retries). */
  maxAttempts?: number;
  /** Backoff sleep — injectable so tests run without real timers. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Whether an error EVENT is worth retrying. Transports hardcode
 * `retryable:false` even on 429/5xx, so a `false` is NOT authoritative — we
 * still classify the message. Only an explicit `true` is trusted as a
 * fast-path.
 */
function errorEventIsRetryable(ev: ErrorLike): boolean {
  if (ev.retryable === true) return true;
  return isRetryable(ev.message ?? ev.code ?? "");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Wrap a transport stream factory with bounded, content-safe retry. `makeStream`
 * MUST create a fresh stream per call (so each retry is a clean re-issue).
 */
export async function* withTransportRetry<T extends { type: string }>(
  makeStream: () => AsyncIterable<T>,
  opts: TransportRetryOpts,
): AsyncIterable<T> {
  const maxAttempts = Math.min(
    MAX_TRANSPORT_ATTEMPTS,
    Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  );
  const delay = opts.delay ?? abortableDelay;
  const aborted = () => opts.signal?.aborted === true || opts.isAborted?.() === true;

  for (let attempt = 1; ; attempt++) {
    let emittedContent = false;
    let retry: { category: ErrorCategory; reason: string } | null = null;

    try {
      for await (const ev of makeStream()) {
        if (ev.type === "error") {
          const e = ev as unknown as ErrorLike;
          const canRetry =
            !emittedContent && attempt < maxAttempts && !aborted() && errorEventIsRetryable(e);
          if (canRetry) {
            retry = {
              category: classify(e.message ?? e.code ?? ""),
              reason: e.message ?? e.code ?? "error",
            };
            break; // abandon this stream (incl. its trailing `done`) and retry
          }
          yield ev; // terminal: forward and let the consumer record firstError
          continue;
        }
        // Any non-error, non-done event is committed output → no retry past here.
        if (ev.type !== "done") emittedContent = true;
        yield ev;
      }
    } catch (e) {
      // Some transports throw instead of yielding an error event.
      const canRetry =
        !emittedContent && attempt < maxAttempts && !aborted() && isRetryable(e);
      if (!canRetry) throw e;
      retry = { category: classify(e), reason: (e as Error)?.message ?? String(e) };
    }

    if (!retry) return; // clean completion, or a forwarded terminal error

    const wait = backoffMs(attempt, retry.category);
    logger.warn(
      `[${opts.label}] transient provider failure (${retry.category}) attempt ${attempt}/${maxAttempts}; retrying in ${Math.round(wait)}ms — ${retry.reason.slice(0, 120)}`,
    );
    await delay(wait, opts.signal);
    if (aborted()) return; // cancelled during backoff
  }
}
