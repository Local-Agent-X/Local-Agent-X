// Retry-aware fetch for the Codex endpoint. Exponential backoff on 5xx,
// 429, and network/timeout errors. Uses a 120s connect-timeout that is
// cleared once headers arrive (so it never truncates the streamed body) and
// composes the caller's external cancel signal so a stop fires immediately.

import { createLogger } from "../logger.js";
import { classify, isRetryable, backoffMs } from "../resilience-policy.js";
import { connectTimeout } from "../providers/connect-timeout.js";

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
    // Connect-timeout (120s) bounds ONLY the request/headers phase and is
    // cleared the instant fetch resolves — otherwise it stays live on the
    // returned Response and aborts the streamed body mid-generation (a partial
    // answer silently standing as complete). The caller's external cancel
    // signal stays composed for the whole body lifetime.
    const conn = connectTimeout(120_000, signal, "Codex");
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: conn.signal,
      });
      conn.clear();

      if (res.ok) return res;

      const errText = await res.text();

      // Auth failures (401/403) are terminal — never retry them, and don't
      // dress them up as a generic "Codex API error". The common trigger is
      // the ChatGPT subscription session being rotated when the user signs
      // in on another device (e.g. phone): the stored OAuth token is still
      // structurally valid locally, so it slips past getApiKey's expiry
      // check and only fails here, server-side. Surface an actionable
      // "reconnect" message. The status code stays in the string so
      // resilience-policy.classify() still tags it `auth`.
      if (res.status === 401 || res.status === 403) {
        logger.error(`[codex] auth ${res.status}:`, errText.slice(0, 300));
        throw new Error(
          `Codex auth failed (HTTP ${res.status}): your ChatGPT/OpenAI session has expired or you signed in on another device. Reconnect OpenAI to continue.`,
        );
      }

      if (isRetryable({ status: res.status }) && attempt < maxRetries) {
        const waitMs = backoffMs(attempt, classify({ status: res.status }));
        logger.warn(`[codex] API ${res.status}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      logger.error(`[codex] API error ${res.status}:`, errText.slice(0, 500));
      throw new Error(`Codex API error ${res.status}: ${errText.slice(0, 500)}`);
    } catch (e) {
      conn.clear();
      // External cancel (barge-in / op-cancel / lease-lost) is terminal — never retry it.
      if (signal?.aborted) throw e;
      // A connect-timeout abort IS retryable, but the manual timer surfaces as
      // a generic AbortError that classify() can't tag as "timeout" — so ask
      // conn directly instead of relying on the message.
      const connectTimedOut = conn.timedOut();
      if (attempt >= maxRetries || (!connectTimedOut && !isRetryable(e))) throw e;
      const waitMs = backoffMs(attempt, connectTimedOut ? "timeout" : classify(e));
      logger.warn(`[codex] ${connectTimedOut ? "connect timeout" : "network error"}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
  }
  // Unreachable: loop either returns on success or throws. Satisfies TS.
  throw new Error("Codex fetch retry loop exited without result");
}
