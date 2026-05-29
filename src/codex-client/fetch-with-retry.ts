// Retry-aware fetch for the Codex endpoint. Exponential backoff on 5xx,
// 429, and network/timeout errors. Composes a 120s connect-timeout signal
// with the caller's external cancel signal so a stop fires immediately
// instead of waiting the full connect window.

import { createLogger } from "../logger.js";
import { classify, isRetryable, backoffMs } from "../resilience-policy.js";

const logger = createLogger("codex-client.fetch");

export interface FetchWithRetryInput {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** External cancel signal — barge-in, op cancel, lease lost. */
  signal?: AbortSignal;
  maxRetries?: number;
}

export async function fetchCodexWithRetry(input: FetchWithRetryInput): Promise<Response> {
  const { url, headers, body, signal, maxRetries = 3 } = input;

  // Fail fast if the caller already cancelled before we even started.
  if (signal?.aborted) {
    throw new Error("Codex request aborted before dispatch");
  }

  let res: Response | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Compose connect-timeout (120s) and the caller's external cancel
      // signal into one fetch signal. If either fires we abort the
      // outgoing request immediately — the worker doesn't wait the full
      // 120s connect window when the user cancels mid-request.
      const fetchSignals: AbortSignal[] = [AbortSignal.timeout(120_000)];
      if (signal) fetchSignals.push(signal);
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: fetchSignals.length > 1 ? AbortSignal.any(fetchSignals) : fetchSignals[0],
      });

      if (res.ok) return res;

      const errText = await res.text();

      if (isRetryable({ status: res.status }) && attempt < maxRetries) {
        const waitMs = backoffMs(attempt, classify({ status: res.status }));
        logger.warn(`[codex] API ${res.status}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      logger.error(`[codex] API error ${res.status}:`, errText.slice(0, 500));
      throw new Error(`Codex API error ${res.status}: ${errText.slice(0, 500)}`);
    } catch (e) {
      if (attempt >= maxRetries || !isRetryable(e)) throw e;
      const msg = (e as Error).message;
      const waitMs = backoffMs(attempt, classify(e));
      logger.warn(`[codex] Network error, retrying in ${Math.round(waitMs)}ms: ${msg.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
  }
  // Unreachable: loop either returns on success or throws. Satisfies TS.
  throw new Error("Codex fetch retry loop exited without result");
}
