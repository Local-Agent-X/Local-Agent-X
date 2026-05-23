// Public types + constants for the Anthropic canonical adapter. Kept here
// so submodules import from a single source-of-truth and the re-export
// surface on ../anthropic.ts stays stable across refactors.
//
// Sandbox boundary note: this file MUST NOT import subprocess primitives
// or OAuth. Only ../anthropic.ts is audited for FORBIDDEN_ADAPTER_IMPORTS,
// but the rule applies transitively — keep this file pure types.

export const ANTHROPIC_ADAPTER_NAME = "anthropic";
export const ANTHROPIC_ADAPTER_VERSION = "1.0.0";
export const PROVIDER_STATE_MAX_BYTES_DEFAULT = 256 * 1024;

// ── Transport contract ───────────────────────────────────────────────────

export interface AnthropicTransportRequest {
  model: string;
  systemPrompt: string;
  messages: TransportMessage[];
  tools: TransportTool[];
  signal: AbortSignal;
  maxTokens?: number;
  /**
   * Chat session id, when this transport is driving a chat op. Used for
   * warm-pool keying so a session reuses a long-lived CLI process across
   * turns instead of cold-spawning per request.
   */
  sessionId?: string;
  /**
   * Force a single tool for this request. The transport translates
   * `{type:"tool", name}` into Anthropic's wire-shape tool_choice on the
   * direct-HTTP path; on the CLI path it appends a system-prompt
   * directive because the subprocess doesn't accept tool_choice flags.
   */
  forcedToolChoice?: { type: "tool"; name: string };
}

export interface TransportMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Required when role === "tool". */
  toolCallId?: string;
  /**
   * Optional assistant tool_calls for round-tripping function_call items
   * across turns. Codex's ChatGPT-backend doesn't support
   * `previous_response_id`, so the message history must include the
   * assistant's prior tool_call(s) before the matching tool_result —
   * otherwise the API rejects with "no tool call found for function call
   * output with call_id …". Set when role === "assistant" and the model
   * emitted tool calls; the per-provider transport translates this to the
   * underlying client's tool-call shape.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * Image attachments riding on this message (only meaningful when
   * role === "user"). Each transport picks them up at request time and
   * folds them into the wire format its provider accepts: OpenAI-compat
   * gets multi-part text+image_url base64; Anthropic gets the same
   * multi-part shape and lets `anthropic-client/request.ts` convert it
   * to Anthropic's `image` content blocks. Codex ignores these — its
   * Responses API path doesn't currently support vision.
   */
  images?: Array<{ url: string; name: string; filePath?: string }>;
}

export interface TransportTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type TransportEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "error"; code: string; message: string; retryable?: boolean }
  | {
      type: "done";
      stopReason?: string;
      /**
       * Optional usage from the underlying provider's terminal frame.
       * Captured into providerState so soak-metrics can read it without
       * subscribing to provider-specific shapes. Populated by both the
       * Anthropic and Codex transports when their respective `result` /
       * `done` events carry usage. Cache fields are Anthropic-specific —
       * Codex returns them as undefined.
       */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreateTokens?: number;
      };
    };

export interface AnthropicTransport {
  stream(req: AnthropicTransportRequest): AsyncIterable<TransportEvent>;
}

// ── Adapter options ──────────────────────────────────────────────────────

export interface AnthropicAdapterOptions {
  /** Defaults to a transport that wraps `streamAnthropicResponse`. */
  transport?: AnthropicTransport;
  /** Provider model id. Override per-op via a custom factory. */
  model?: string;
  /** System prompt applied to every turn. */
  systemPrompt?: string;
  /** Per-turn output token cap. */
  maxTokens?: number;
  /** PRD §21: 256 KB suggested cap on `provider_state` JSON size. */
  providerStateMaxBytes?: number;
  /**
   * When this adapter drives a chat op, the session id is propagated to
   * the transport so the warm pool reuses one CLI process across turns
   * for the session.
   */
  sessionId?: string;
  /**
   * Forced single tool for this op's first turn — surfaced from the
   * intent classifier in prepare-request.ts. Anthropic's API accepts
   * `tool_choice: { type: "tool", name: "..." }`; the CLI subprocess
   * doesn't expose tool_choice as a flag, so the transport pivots that
   * into a system-prompt directive when the auth path is OAuth/CLI.
   */
  forcedToolChoice?: { type: "tool"; name: string };
}

// ── Stream-consume result ────────────────────────────────────────────────
//
// What the per-turn streaming loop accumulates before the adapter
// finalizes the assistant message and computes terminalReason. Mirrors
// openai-compat's StreamOnceResult shape but with Anthropic-specific
// usage fields (cache read/create tokens).

export interface StreamConsumeResult {
  assembledText: string;
  toolCallIds: string[];
  firstError: { code: string; message: string } | null;
  providerStop: string | undefined;
  usageInputTokens: number | undefined;
  usageOutputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreateTokens: number | undefined;
  /** Mid-stream user-inject interrupt — caller should set its own aborted
   *  flag so post-stream handling treats the turn as aborted. */
  interruptedByInject: boolean;
}
