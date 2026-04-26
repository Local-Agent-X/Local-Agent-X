/**
 * Unified response classification across all providers.
 *
 * Every provider (Codex, Anthropic, OpenAI, xAI, local, gemini, custom) returns
 * responses in a different format with different fields indicating why the
 * model stopped. This module normalizes them all into a single classification
 * so the agent loop can make informed decisions about retries, fallbacks, and
 * error messages.
 *
 * Without this, when a model returns empty we don't know WHY — is it content
 * moderation? Token limit? Reasoning timeout? Tool schema error? Each requires
 * a different response (retry vs. fallback vs. user error).
 */

import { createLogger } from "./logger.js";
const logger = createLogger("response-classifier");

export type ResponseClassification =
  | "completed"        // Normal completion with content
  | "tool_called"      // Model called a tool (not final)
  | "content_filter"   // Content moderation blocked the response (still 200 OK, empty content)
  | "token_limit"      // Hit max_tokens — response was cut off
  | "rate_limit"       // Hit rate limit (429) — retryable after backoff
  | "reasoning_timeout" // Reasoning model ran out of thinking budget
  | "empty"            // No content, no tool calls, unknown reason
  | "error"            // Explicit API error
  | "aborted";         // User or silence-timeout aborted the stream

export interface ClassificationResult {
  /** Normalized classification */
  type: ResponseClassification;
  /** Original stop/finish reason from the provider, if any */
  rawReason?: string;
  /** Human-readable explanation */
  explanation: string;
  /** Whether to retry on the same model */
  shouldRetry: boolean;
  /** Whether to fall back to a different model */
  shouldFallback: boolean;
  /** Provider-specific metadata for diagnostics */
  meta?: Record<string, unknown>;
}

/** Classify a Codex / OpenAI Responses API response. */
export function classifyCodexResponse(opts: {
  hasText: boolean;
  hasToolCalls: boolean;
  outputTypes?: string[];       // types of items in response.output array
  status?: string;              // response.status field
  inputTokens?: number;
  outputTokens?: number;
}): ClassificationResult {
  const { hasText, hasToolCalls, outputTypes = [], status, inputTokens = 0, outputTokens = 0 } = opts;

  if (hasToolCalls) {
    return { type: "tool_called", explanation: "Model called one or more tools", shouldRetry: false, shouldFallback: false };
  }

  if (hasText) {
    return { type: "completed", explanation: `Normal completion (${outputTokens} output tokens)`, shouldRetry: false, shouldFallback: false, rawReason: status };
  }

  // Empty response — need to figure out why
  if (status === "incomplete" || status === "failed") {
    return {
      type: "error",
      rawReason: status,
      explanation: `Response marked ${status} — likely a server-side issue`,
      shouldRetry: true, shouldFallback: false,
    };
  }

  // Output contains only reasoning items? That means Codex thought but didn't respond.
  // Usually caused by reasoning_effort timeout or excessive system prompt + tools.
  if (outputTypes.length > 0 && outputTypes.every(t => t === "reasoning")) {
    return {
      type: "reasoning_timeout",
      rawReason: "reasoning-only output",
      explanation: "Model reasoned but didn't produce output. Likely: prompt too heavy, reasoning_effort too high, or token budget exhausted by reasoning.",
      shouldRetry: false, shouldFallback: true,
      meta: { inputTokens, outputTokens, outputTypes },
    };
  }

  // Zero tokens in AND out usually means content moderation blocked the input silently
  if (inputTokens === 0 && outputTokens === 0) {
    return {
      type: "content_filter",
      explanation: "Zero tokens processed — likely content moderation blocked the request before generation",
      shouldRetry: false, shouldFallback: true,
    };
  }

  // Output tokens were consumed but nothing came back — reasoning timeout variant
  if (outputTokens > 0) {
    return {
      type: "reasoning_timeout",
      explanation: `Model consumed ${outputTokens} tokens on reasoning but produced no visible output`,
      shouldRetry: false, shouldFallback: true,
      meta: { inputTokens, outputTokens },
    };
  }

  return {
    type: "empty",
    rawReason: status,
    explanation: "Model returned empty response for unknown reason",
    shouldRetry: true, shouldFallback: true,
    meta: { inputTokens, outputTokens, outputTypes },
  };
}

/** Classify an Anthropic Messages API response. */
export function classifyAnthropicResponse(opts: {
  hasText: boolean;
  hasToolCalls: boolean;
  stopReason?: string;          // "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal"
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
}): ClassificationResult {
  const { hasText, hasToolCalls, stopReason, inputTokens = 0, outputTokens = 0, errorMessage } = opts;

  if (errorMessage) {
    if (errorMessage.includes("429") || /rate.?limit/i.test(errorMessage)) {
      return { type: "rate_limit", rawReason: errorMessage, explanation: "Rate limit exceeded", shouldRetry: true, shouldFallback: true };
    }
    return { type: "error", rawReason: errorMessage, explanation: errorMessage, shouldRetry: false, shouldFallback: true };
  }

  switch (stopReason) {
    case "tool_use":
      return { type: "tool_called", rawReason: stopReason, explanation: "Model called a tool", shouldRetry: false, shouldFallback: false };
    case "end_turn":
    case "stop_sequence":
      return hasText
        ? { type: "completed", rawReason: stopReason, explanation: `Normal completion (${outputTokens} tokens)`, shouldRetry: false, shouldFallback: false }
        : { type: "empty", rawReason: stopReason, explanation: "Model finished normally but produced no content", shouldRetry: true, shouldFallback: true };
    case "max_tokens":
      return { type: "token_limit", rawReason: stopReason, explanation: "Response was cut off at max_tokens", shouldRetry: false, shouldFallback: false };
    case "refusal":
      return { type: "content_filter", rawReason: stopReason, explanation: "Model refused the request (content policy)", shouldRetry: false, shouldFallback: true };
  }

  if (hasToolCalls) return { type: "tool_called", explanation: "Model called a tool", shouldRetry: false, shouldFallback: false };
  if (hasText) return { type: "completed", explanation: "Normal completion", shouldRetry: false, shouldFallback: false };

  return {
    type: "empty",
    rawReason: stopReason,
    explanation: "No content, no tool calls, no stop reason",
    shouldRetry: true, shouldFallback: true,
    meta: { inputTokens, outputTokens },
  };
}

/** Classify an OpenAI Chat Completions API response (used for openai, xai, local, gemini, custom). */
export function classifyOpenAIResponse(opts: {
  hasText: boolean;
  hasToolCalls: boolean;
  finishReason?: string;        // "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}): ClassificationResult {
  const { hasText, hasToolCalls, finishReason, errorMessage, inputTokens = 0, outputTokens = 0 } = opts;

  if (errorMessage) {
    if (errorMessage.includes("429") || /rate.?limit/i.test(errorMessage)) {
      return { type: "rate_limit", rawReason: errorMessage, explanation: "Rate limit exceeded", shouldRetry: true, shouldFallback: true };
    }
    return { type: "error", rawReason: errorMessage, explanation: errorMessage, shouldRetry: false, shouldFallback: true };
  }

  switch (finishReason) {
    case "tool_calls":
    case "function_call":
      return { type: "tool_called", rawReason: finishReason, explanation: "Model called a tool", shouldRetry: false, shouldFallback: false };
    case "stop":
      return hasText
        ? { type: "completed", rawReason: finishReason, explanation: `Normal completion (${outputTokens} tokens)`, shouldRetry: false, shouldFallback: false }
        : { type: "empty", rawReason: finishReason, explanation: "Model stopped normally but produced no content", shouldRetry: true, shouldFallback: true };
    case "length":
      return { type: "token_limit", rawReason: finishReason, explanation: "Response cut off at max_tokens", shouldRetry: false, shouldFallback: false };
    case "content_filter":
      return { type: "content_filter", rawReason: finishReason, explanation: "Content moderation blocked the response", shouldRetry: false, shouldFallback: true };
  }

  if (hasToolCalls) return { type: "tool_called", explanation: "Model called a tool", shouldRetry: false, shouldFallback: false };
  if (hasText) return { type: "completed", explanation: "Normal completion", shouldRetry: false, shouldFallback: false };

  // No finish_reason, no content — usually means the stream ended abnormally
  if (inputTokens === 0 && outputTokens === 0) {
    return {
      type: "content_filter",
      explanation: "Zero tokens — likely content moderation or malformed request",
      shouldRetry: false, shouldFallback: true,
    };
  }

  return {
    type: "empty",
    rawReason: finishReason,
    explanation: "No content, no tool calls, stream ended",
    shouldRetry: true, shouldFallback: true,
    meta: { inputTokens, outputTokens },
  };
}

/** Log a classification result in a consistent format. */
export function logClassification(provider: string, model: string, result: ClassificationResult): void {
  const tag = `[classify:${provider}/${model}]`;
  if (result.type === "completed" || result.type === "tool_called") {
    // Quiet success — only log if debug
    return;
  }
  logger.warn(`${tag} ${result.type} — ${result.explanation}${result.rawReason ? ` (raw: ${result.rawReason})` : ""}`);
}
