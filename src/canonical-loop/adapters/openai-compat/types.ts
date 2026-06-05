// Shared types + constants for the OpenAI-compat adapter. Kept in one file
// so submodules import a single source-of-truth for adapter name/version and
// the option/result shapes.

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
