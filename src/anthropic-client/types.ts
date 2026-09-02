import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface StreamEvent {
  type: "text" | "thinking" | "tool_call" | "mcp_activity" | "done" | "error";
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
  /** Turn extended thinking OFF for this request and honor `temperature`
   *  verbatim (legacy models only — the adaptive family rejects sampling
   *  params). For short yes/no classifier calls: extended thinking burns
   *  seconds of reasoning tokens a verdict doesn't need. Also set by the
   *  voice turn path: thinking time is dead air in a spoken reply.
   *  Wire shape is per-model (anthropicThinkingOffMode): legacy + the 4.6
   *  generation omit `thinking`; Opus 5 / Sonnet 5 / Opus 4.7/4.8 send
   *  `{type: "disabled"}` because omission leaves adaptive thinking ON on
   *  Opus 5 / Sonnet 5. CAVEAT — Fable 5 / Mythos 5 cannot disable thinking
   *  at all (explicit disable 400s, omission runs adaptive): the flag logs a
   *  once-per-process warning there and the call still pays thinking
   *  latency/tokens; pick a different model if latency is load-bearing.
   *  Only the direct-HTTP path reads this. */
  disableThinking?: boolean;
  /** Byte length of the stable prefix of `systemPrompt`. When set (and > 0,
   *  < systemPrompt.length), the system prompt is sent as TWO text blocks —
   *  [0, len) carrying the cache_control breakpoint, [len, end) uncached —
   *  so per-turn churn in the tail (memory context, notices) no longer
   *  invalidates the cached tools+system prefix. Callers must slice on a
   *  section boundary they control; an arbitrary mid-token split is safe for
   *  the API but wastes the cache on the next byte-different turn. */
  systemStablePrefixLen?: number;
  /** Mark the LAST message with a cache_control breakpoint so the whole
   *  conversation prefix caches across turns. Only worth setting when the
   *  system prompt is byte-stable across turns (see systemStablePrefixLen) —
   *  the messages tier can only hit when everything before it matches. */
  cacheConversation?: boolean;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

// cache_control is intersected onto every variant so the message-tier
// prompt-caching breakpoint (StreamOptions.cacheConversation) can land on
// whatever block type happens to be last in the conversation.
export type AnthropicContent = (
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
) & { cache_control?: { type: "ephemeral" } };
