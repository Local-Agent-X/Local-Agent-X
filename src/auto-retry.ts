
import { createLogger } from "./logger.js";
import type { RetryContext } from "./retry-context.js";
const logger = createLogger("auto-retry");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** The turn's retry context; its correlationId goes on each retry's log
   *  line. The local maxRetries is the only cap (see retry-context.ts). */
  ctx?: RetryContext;
  /** Layer label for log lines. Defaults to "L1-tool". */
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
    // No shared-budget gate: one that threw "retry budget exhausted" killed
    // slow-start tools like `browser` BEFORE their first real attempt when
    // the turn had spent the budget on earlier prep work. Each call's local
    // `maxRetries` is the cap.
    try {
      return await fn();
    } catch (err) {
      lastError = err;
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
