import { createLogger } from "../logger.js";

const logger = createLogger("embedding-providers");

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
  baseDelay = 1000,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const mergedInit = { ...init };
    if (init.signal) {
      mergedInit.signal = AbortSignal.any([init.signal, timeoutSignal]);
    } else {
      mergedInit.signal = timeoutSignal;
    }
    const res = await fetch(url, mergedInit);
    if (res.status === 429 && attempt < retries) {
      const delay = baseDelay * 2 ** attempt + Math.random() * 500;
      logger.warn(
        `[embeddings] Rate-limited (429), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})`,
      );
      await sleep(delay);
      continue;
    }
    return res;
  }
  // Unreachable, but satisfies TS
  throw new Error("fetchWithRetry: all retries exhausted");
}

export function emptyVector(dims: number): number[] {
  return new Array(dims).fill(0);
}
