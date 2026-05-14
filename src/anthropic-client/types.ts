import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface StreamEvent {
  type: "text" | "tool_call" | "mcp_activity" | "done" | "error";
  delta?: string;
  id?: string;
  name?: string;
  arguments?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic prompt-cache hit tokens (10% of normal cost). */
    cacheReadTokens?: number;
    /** Anthropic prompt-cache write tokens (1.25× normal cost). */
    cacheCreateTokens?: number;
  };
  error?: string;
  /** Stop reason from the API — populated on done/error */
  stopReason?: string;
  /** Classification of why the response ended */
  classification?: import("../response-classifier.js").ClassificationResult;
}

export interface StreamOptions {
  token: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  temperature?: number;
  maxTokens?: number;
  /** If true, don't fall back to CLI proxy on 429 — yield error instead */
  skipCliFallback?: boolean;
  /** Force tool use: "required" makes the model call a tool. "auto" (default) lets it decide. */
  toolChoice?: "auto" | "required";
  /**
   * Force a SPECIFIC tool by name (intent-classifier path). On the direct
   * HTTP path this becomes `tool_choice: { type: "tool", name }`. On the
   * CLI path the caller is expected to have already nudged the system
   * prompt — this field is informational there.
   */
  forcedToolName?: string;
  /** Session id passed to the MCP bridge subprocess as LAX_MCP_SESSION_ID
   *  so it can stamp every /api/mcp/call POST with the right session. The
   *  server uses that to look up the session's onEvent (so tool side-effects
   *  like voice_visual reach the right WebSocket). */
  sessionId?: string;
  /** Abort signal — when fired, kills the spawned `claude` subprocess so a
   *  user "Stop" actually halts the in-flight CLI run (token burn + tool
   *  calls). Without this, abort only stops the JS-side stream consumption
   *  while the subprocess keeps running. */
  signal?: AbortSignal;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

export type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
