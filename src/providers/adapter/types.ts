/**
 * Provider adapter types — shared across every adapter (Anthropic HTTP,
 * Anthropic CLI, OpenAI, Codex, Ollama, etc.). Single source of truth so
 * adapters stay interchangeable and the dispatcher (run-standard.ts after
 * migration) can swap them without per-provider conditionals.
 *
 * Pattern from /tmp/compare/upstream-agent-main/agent/anthropic_adapter.py
 * + bedrock_adapter.py + codex_responses_adapter.py — each adapter is
 * one file implementing the same interface.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, ServerEvent } from "../../types.js";

/**
 * Normalized request shape that every adapter accepts. The dispatcher
 * builds this once from AgentOptions; adapters translate it into their
 * provider-specific format internally.
 */
export interface ProviderRequest {
  apiKey: string;
  model: string;
  baseURL?: string;
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Force tool use on this request ("required" = model MUST call a tool). */
  toolChoice?: "auto" | "required";
  /** Session id for downstream tracking (MCP bridge, telemetry). */
  sessionId?: string;
  /** Abort signal — adapters MUST honor this (kill subprocess, abort fetch). */
  signal?: AbortSignal;
  /** Per-event callback for streaming UI updates. Adapters emit normalized events. */
  onEvent?: (event: ServerEvent) => void;
}

/**
 * Normalized streaming chunk emitted by every adapter. Callers iterate
 * the stream and dispatch on `type` — provider-specific event shapes are
 * translated to this in the adapter.
 */
export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "thinking"; delta: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; statusCode?: number }
  | { type: "mcp_activity"; toolName?: string; arguments?: string };

/**
 * Tool call as emitted in the final response (when not streaming
 * incrementally). Used by callers who want a synchronous summary
 * after the stream closes.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * What an adapter returns from `invoke()` — the non-streaming
 * convenience path. Streaming adapters MAY implement this by collecting
 * their own stream into a single result.
 */
export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  stopReason: string;
}
