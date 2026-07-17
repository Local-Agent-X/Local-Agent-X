// Shared types + constants for the OpenAI-compat adapter. Kept in one file
// so submodules import a single source-of-truth for adapter name/version and
// the option/result shapes.

import type { ReasoningEffort } from "../../../providers/reasoning-effort.js";

export const OPENAI_COMPAT_ADAPTER_NAME = "openai-compat";
export const OPENAI_COMPAT_ADAPTER_VERSION = "1.0.0";
export const PROVIDER_STATE_MAX_BYTES = 256 * 1024;

export interface OpenAICompatAdapterOptions {
  /** Required. The model id the OpenAI-compat endpoint expects. */
  model: string;
  /** Required. Full OpenAI-compatible base URL (must include `/v1`). */
  baseURL: string;
  /** Required. Bearer token. Use a placeholder ("ollama") for local
   *  Ollama which doesn't auth. */
  apiKey: string;
  systemPrompt?: string;
  temperature?: number;
  /** Hard output-token cap forwarded as ProviderRequest.maxTokens →
   *  `max_tokens` on the wire. Same contract as the Anthropic/Codex adapter
   *  options (callers like a voice lane cap their replies). Absent = the
   *  adapter's own policy (local endpoints get a runaway default, cloud
   *  endpoints stay uncapped — see providers/adapters/openai-http.ts). */
  maxTokens?: number;
  /** User-selected thinking depth — forwarded as reasoning_effort on
   *  reasoning-capable models (xhigh clamps to high on Chat Completions). */
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
  /**
   * Forced single-tool selection from the intent classifier. Applied on
   * turn 0 only — subsequent turns release the pin so the model can
   * narrate or chain. Undefined = "auto" (no force).
   */
  forcedToolChoice?: { type: "tool"; name: string };
  /**
   * Force the model to emit SOME tool call on turn 0 (`tool_choice:
   * "required"`) when tools are available and no specific forcedToolChoice
   * is pinned. Set by the agent-runner path: spawned field agents are
   * expected to act, and weaker OpenAI-compat models (xAI Grok) otherwise
   * narrate their first tool call as prose instead of calling it. Turn-0
   * only; the pin releases afterward. No-op when the agent has no tools.
   */
  requireToolOnFirstTurn?: boolean;
}

export interface StreamOnceResult {
  assembledText: string;
  assembledThinking: string;
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>;
  firstError: { code: string; message: string } | null;
  providerStop: string | undefined;
  usagePromptTokens: number | undefined;
  usageCompletionTokens: number | undefined;
  /** Mid-stream user-inject interrupt — caller should set its own aborted
   *  flag so post-stream handling treats the turn as aborted. */
  interruptedByInject: boolean;
  /** Degenerate-output guard tripped mid-stream (local endpoints only) and
   *  the stream was cut early; value is the detector detail. Caller treats
   *  the turn as cleanly DONE with the partial text — never error, never
   *  retried. See stream-guards.ts. */
  stoppedByGuard?: string;
}

export interface OpenAICompatTarget {
  baseURL: string;
  apiKey: string;
}

export interface CanonicalImageRef {
  url: string;
  name: string;
  filePath?: string;
}
