import { createLogger } from "../logger.js";
import { connectTimeout } from "../providers/connect-timeout.js";

const logger = createLogger("codex-client.fetch");

export interface FetchOnceInput {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function fetchCodexOnce(input: FetchOnceInput): Promise<Response> {
  const { url, headers, body, signal } = input;
  if (signal?.aborted) throw new Error("Provider request aborted before dispatch");

  const conn = connectTimeout(120_000, signal, "Provider");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: conn.signal,
    });
    conn.clear();
    if (res.ok) return res;

    const errText = await res.text();
    if (res.status === 401 || res.status === 403) {
      logger.error(`[provider] auth ${res.status}:`, errText.slice(0, 300));
      throw new Error(
        `Provider auth failed (HTTP ${res.status}): the connected session expired. Reconnect the provider to continue.`,
      );
    }
    logger.error(`[provider] API error ${res.status}:`, errText.slice(0, 500));
    throw new Error(`Provider API error ${res.status}: ${errText.slice(0, 500)}`);
  } catch (error) {
    const timedOut = conn.timedOut();
    conn.clear();
    if (timedOut && !signal?.aborted) {
      throw new Error(`Provider connect timeout: ${(error as Error).message}`);
    }
    throw error;
  }
}
