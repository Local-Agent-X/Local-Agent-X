
import { createLogger } from "./logger.js";
import type { RetryContext } from "./retry-context.js";
const logger = createLogger("auto-retry");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Optional shared retry budget. When passed, attempts also count
   *  against ctx.budget; withRetry bails early if the budget or deadline
   *  is exhausted even when the local maxRetries is not. */
  ctx?: RetryContext;
  /** Layer label for ctx.onAttempt / log lines. Defaults to "L1-tool". */
  layer?: string;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

function computeDelay(attempt: number, base: number, max: number): number {
  const exponential = base * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.5;
  return Math.min(exponential + jitter, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  const layer = opts.layer ?? "L1-tool";
  const corr = opts.ctx?.correlationId;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    // Budget check BEFORE the attempt: a shared context may have already
    // burned its attempts on a prior withRetry call in the same request.
    if (opts.ctx) {
      const b = opts.ctx.budget;
      if (b.attemptsUsed >= b.maxAttempts) {
        if (lastError) throw lastError;
        throw new Error(`retry budget exhausted (${b.attemptsUsed}/${b.maxAttempts})`);
      }
      if (Date.now() >= b.deadlineMs) {
        if (lastError) throw lastError;
        throw new Error("retry deadline exceeded");
      }
      b.attemptsUsed++;
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;
      try { opts.ctx?.onAttempt?.(layer, attempt + 1, err instanceof Error ? err : new Error(String(err))); } catch { /* hook must not break flow */ }

      if (attempt >= opts.maxRetries) break;
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt + 1)) break;

      const delay = computeDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      logger.info(
        `[retry]${corr ? ` correlationId=${corr}` : ""} ${layer} attempt ${attempt + 1}/${opts.maxRetries} failed, retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
