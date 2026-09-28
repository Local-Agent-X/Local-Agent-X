/**
 * Which HTTP transport carries an openai-compat request. One rule:
 * a baseURL that is the chat base of a DISCOVERED Ollama runtime rides
 * Ollama's native /api/chat (providers/adapters/ollama-native.ts), the only
 * endpoint that honours num_ctx and keep_alive; everything else — OpenAI,
 * xAI, Gemini compat, Cerebras, custom, Ollama Cloud, LM Studio, vLLM,
 * llama.cpp, an Ollama URL discovery never confirmed — rides Chat
 * Completions (openai-http.ts). Both share one contract, so stream-once is
 * transport-blind.
 */
import type { BaseAdapter } from "../../../providers/adapter/base-adapter.js";

export type ChatTransportName = "ollama-native" | "openai-http";

export async function chatTransportName(baseURL: string | undefined): Promise<ChatTransportName> {
  const { ollamaNativeRootForChatBase } = await import("../../../local-runtimes/cache.js");
  return ollamaNativeRootForChatBase(baseURL) ? "ollama-native" : "openai-http";
}

export async function chatTransportFor(baseURL: string | undefined): Promise<Pick<BaseAdapter, "stream">> {
  if (await chatTransportName(baseURL) === "ollama-native") {
    return (await import("../../../providers/adapters/ollama-native.js")).ollamaNativeAdapter;
  }
  return (await import("../../../providers/adapters/openai-http.js")).openaiHttpAdapter;
}
