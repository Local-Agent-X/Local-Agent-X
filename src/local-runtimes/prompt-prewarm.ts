/**
 * New-chat prompt pre-warm for the local runtime.
 *
 * A hybrid-attention model (qwen3.6:27b is `qwen35`: full attention every
 * fourth layer, a recurrent state in the rest) cannot rewind its cache to an
 * arbitrary shared prefix. Ollama restores it only from near the END of the
 * last prefill, a window of roughly 1k tokens. By the time a chat ends, that
 * point sits tens of thousands of tokens past the system prompt and tools, so
 * a new chat re-read the whole ~27k-token head: 9-10 s before its first token
 * (docs/harness/HARNESS_LOG.md, "Probe — can a new chat reuse the cache").
 *
 * The head is the same for every fresh chat, so it is recorded from the last
 * fresh chat's first request and replayed, with a one-word user turn, when
 * the user opens a new chat. That prefill ends a few tokens past the head, so
 * the real first message reuses it. Replaying the recorded request through the
 * same HTTP adapter keeps the wire bytes identical; re-running the turn
 * pipeline with a stub message would recall memory and fire classifiers.
 *
 * One cache slot per model: a pre-warm evicts the chat the user is leaving,
 * which is why it runs only on a new-chat signal, never after a turn.
 */
import type { ProviderRequest, StreamChunk } from "../providers/adapter/types.js";
import { isLoopbackOrPrivateUrl } from "../local-only-policy.js";
import { createLogger } from "../logger.js";

const logger = createLogger("local-runtimes.prompt-prewarm");

// Covers a cold model load plus a full head prefill; only bounds a hung socket.
const PREWARM_TIMEOUT_MS = 120_000;

type ChatHead = Pick<ProviderRequest, "apiKey" | "baseURL" | "model" | "systemPrompt" | "tools" | "temperature" | "reasoningEffort">;

let lastHead: ChatHead | null = null;
let inflight = false;

/** Record the first request of a fresh local chat as the head to replay. */
export function noteFreshChatHead(req: ProviderRequest): void {
  if (!req.baseURL || !isLoopbackOrPrivateUrl(req.baseURL)) return;
  const { apiKey, baseURL, model, systemPrompt, tools, temperature, reasoningEffort } = req;
  lastHead = { apiKey, baseURL, model, systemPrompt, tools, temperature, reasoningEffort };
}

export type PrewarmOutcome = "started" | "no-head" | "other-model" | "busy";

export interface PrewarmDeps {
  /** The chat's current provider and model, from settings. */
  current: { provider: string; model: string };
  /** A foreground turn is running; a pre-warm would queue behind it. */
  foregroundBusy: boolean;
  send?: (req: ProviderRequest) => AsyncIterable<StreamChunk>;
}

// The same Chat Completions client a chat turn streams through, loaded lazily
// as stream-once.ts does, so the replay's wire bytes match the real request.
async function* defaultSend(req: ProviderRequest): AsyncIterable<StreamChunk> {
  const { openaiHttpAdapter } = await import("../providers/adapters/openai-http.js");
  yield* openaiHttpAdapter.stream(req);
}

/** Replay the recorded head in the background. Never throws. */
export function prewarmNewChat(deps: PrewarmDeps): PrewarmOutcome {
  const head = lastHead;
  if (!head) return "no-head";
  if (deps.current.provider !== "local" || deps.current.model !== head.model) return "other-model";
  if (inflight || deps.foregroundBusy) return "busy";
  inflight = true;
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(PREWARM_TIMEOUT_MS);
  const req: ProviderRequest = { ...head, messages: [{ role: "user", content: "." }], maxTokens: 1, signal };
  void (async () => {
    let outcome = "ok";
    try {
      for await (const ev of (deps.send ?? defaultSend)(req)) {
        if (ev.type === "error") outcome = `error ${ev.statusCode ?? ""} ${ev.message}`.trim();
        if (ev.type === "usage" && outcome === "ok") outcome = `prompt ${ev.promptTokens}, cached ${ev.cachedTokens ?? "?"}`;
      }
    } catch (err) {
      outcome = `failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      inflight = false;
    }
    logger.info(`new-chat pre-warm ${head.model} ${Date.now() - startedAt}ms (${outcome})`);
  })();
  return "started";
}

/** Tests only. */
export function _resetPrewarmForTests(): void {
  lastHead = null;
  inflight = false;
}
