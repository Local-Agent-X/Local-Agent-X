/**
 * ChatGPT Codex Responses API client.
 * Uses the same endpoint and headers as the pi-ai library.
 * This lets $20/mo ChatGPT subscribers use the API for free.
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 * Headers: originator, chatgpt-account-id, OpenAI-Beta
 * Format: OpenAI Responses API (not Chat Completions)
 *
 * Helpers split into ./codex-client/* — this file is the orchestrator.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createLogger } from "./logger.js";

import {
  CODEX_URL,
  type CodexTool,
  type CodexStreamEvent,
  type CodexStreamYield,
} from "./codex-client/types.js";
import { buildHeaders, buildRequestBody } from "./codex-client/request.js";
import { fetchCodexWithRetry } from "./codex-client/fetch-with-retry.js";
import {
  createCodexStreamState,
  processCodexEvent,
  flushOnAbnormalClose,
} from "./codex-client/stream-parse.js";

export type { ReasoningItem } from "./codex-message-convert.js";
export type { CodexResponse } from "./codex-client/types.js";

const logger = createLogger("codex-client");

export async function* streamCodexResponse(params: {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: CodexTool[];
  temperature?: number;
  previousResponseId?: string;
  sessionId?: string;
  toolChoice?: "auto" | "required" | { type: "tool"; name: string } | { type: "function"; function: { name: string } };
  /**
   * External cancel signal. When the caller's op is cancelled (barge-in,
   * user pressed stop, lease lost) firing this signal cancels the in-flight
   * fetch AND cancels the body reader so the worker releases immediately
   * instead of waiting for the 90s silence timeout to trip.
   */
  signal?: AbortSignal;
}): AsyncGenerator<CodexStreamYield> {
  const headers = buildHeaders(params.token);
  const body = buildRequestBody({
    model: params.model,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
  });

  const res = await fetchCodexWithRetry({
    url: CODEX_URL,
    headers,
    body,
    signal: params.signal,
  });

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Codex returned empty response — try again.");

  const decoder = new TextDecoder();
  let buffer = "";
  const state = createCodexStreamState();

  // Stream-phase cancellation. Two sources can stop the read loop:
  //   (a) caller's external signal — barge-in, op cancel, lease lost.
  //       Wired here so reader.cancel() fires the moment the caller
  //       aborts. Previously the in-flight read would block until
  //       Codex's own TCP/keep-alive timed out, parking the worker.
  //   (b) silence timer — 90s without bytes from upstream. Resets on
  //       every chunk so long builds stay alive while output streams.
  // Both call reader.cancel(), which rejects the pending read() and
  // unwinds the loop via the catch at the read site below.
  const SILENCE_TIMEOUT_MS = 90_000;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelReader = () => { void reader.cancel().catch(() => {}); };

  let externalAbortHandler: (() => void) | null = null;
  if (params.signal) {
    if (params.signal.aborted) {
      cancelReader();
    } else {
      externalAbortHandler = () => cancelReader();
      params.signal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      logger.warn("[codex] No data for 90s — aborting (silence timeout)");
      cancelReader();
    }, SILENCE_TIMEOUT_MS);
  }
  resetSilenceTimer();

  while (true) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      const result = await reader.read();
      done = result.done;
      value = result.value;
    } catch {
      break; // Reader aborted by silence timer or external signal
    }
    if (done) break;

    resetSilenceTimer(); // Data arrived — reset the silence clock
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let event: CodexStreamEvent;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      yield* processCodexEvent(event, state, params.model);
    }
  }

  // Clean up silence timer + external-signal listener so we don't leak
  // a per-stream subscription on the caller's AbortSignal.
  if (silenceTimer) clearTimeout(silenceTimer);
  if (externalAbortHandler && params.signal) {
    params.signal.removeEventListener("abort", externalAbortHandler);
  }

  // Fallback: if the stream ended without a response.completed event,
  // yield any tool calls that were collected but never finalized.
  const usageWithMeta = state.usage as Record<string, unknown>;
  if (!usageWithMeta.classification) {
    yield* flushOnAbnormalClose(state, params.model);
  }

  yield {
    type: "done",
    usage: state.usage,
    responseId: state.responseId,
    reasoning: state.reasoningItems,
  };
}
