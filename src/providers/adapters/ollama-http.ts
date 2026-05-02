/**
 * Ollama HTTP adapter — local Ollama daemon speaks the OpenAI Chat
 * Completions wire format on /v1, so this is just an OpenAIHttpAdapter
 * with a different default baseURL. Kept as a separate class so the
 * dispatcher can route by provider name without inspecting URLs.
 *
 * The actual "model doesn't support tools" fallback for Ollama lives
 * inside OpenAIHttpAdapter — same code path, no duplication.
 */

import { OpenAIHttpAdapter } from "./openai-http.js";

export class OllamaHttpAdapter extends OpenAIHttpAdapter {
  readonly name = "ollama-http";
}

export const ollamaHttpAdapter = new OllamaHttpAdapter();
