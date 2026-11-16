/**
 * Keeps a chat's requests to xAI on one server, where its prompt cache lives.
 *
 * xAI caches a prompt prefix per server, and a request lands on any of them
 * unless it carries `x-grok-conv-id`
 * (docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
 * Without it a voice call's turns read 1k–50k of a 66k–72k-token prompt from
 * cache (2026-11-15) where Claude's read 80k–117k, so most Grok turns paid to
 * read the whole prompt again before the first word. Like Codex's
 * `prompt_cache_key`, the header carries a hash of the LAX session, never the
 * id itself.
 */
import { createHash } from "node:crypto";

export const XAI_CONVERSATION_HEADER = "x-grok-conv-id";

function isXaiEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).hostname === "api.x.ai";
  } catch {
    return false; // not a URL: not xAI
  }
}

/** The headers that route this session's requests to one cache; empty for any
 *  endpoint but xAI, or a request with no session. */
export function cacheRoutingHeaders(baseURL: string | undefined, sessionId: string | undefined): Record<string, string> {
  if (!sessionId || !isXaiEndpoint(baseURL)) return {};
  const key = createHash("sha256").update(`lax-xai:${sessionId}`).digest("hex").slice(0, 32);
  return { [XAI_CONVERSATION_HEADER]: key };
}
