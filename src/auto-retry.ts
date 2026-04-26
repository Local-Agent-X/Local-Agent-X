
import { createLogger } from "./logger.js";
const logger = createLogger("auto-retry");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
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
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= opts.maxRetries) break;

      if (opts.shouldRetry && !opts.shouldRetry(err, attempt + 1)) break;

      const delay = computeDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      logger.info(
        `[retry] attempt ${attempt + 1}/${opts.maxRetries} failed, retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
