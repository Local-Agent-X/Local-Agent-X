/**
 * Codex Payload Policy
 *
 * Decides which fields to include in Codex Responses API requests
 * based on the provider endpoint and model. Different endpoints
 * have different requirements:
 *
 * - Codex endpoint (chatgpt.com): store=false required, reasoning=high
 * - Regular OpenAI API: store=true, server compaction enabled
 * - Non-OpenAI proxies: strip reasoning payload entirely
 *
 * This keeps request-building logic out of the streaming client
 * and makes it easy to tune per-model behavior.
 */

// ── Types ──

export interface CodexPayloadPolicy {
  /** Whether to include the reasoning block */
  shouldIncludeReasoning: boolean;
  /** Reasoning effort level */
  reasoningEffort: "low" | "medium" | "high";
  /** Reasoning summary style */
  reasoningSummary: "auto" | "detailed" | "concise";
  /** Whether to include the store field */
  shouldIncludeStore: boolean;
  /** Value for the store field when included */
  storeValue: boolean;
  /** Token threshold before compaction kicks in */
  compactThreshold: number;
  /** Whether the server supports its own compaction */
  shouldUseServerCompaction: boolean;
}

// ── Model classification helpers ──

/** Models that support the reasoning block */
const REASONING_MODELS = new Set([
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "o3",
  "o3-mini",
  "o4-mini",
]);

function supportsReasoning(model: string): boolean {
  if (REASONING_MODELS.has(model)) return true;
  const lower = model.toLowerCase();
  return lower.includes("codex") || lower.startsWith("o3") || lower.startsWith("o4");
}

function isCodexModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("codex") || lower.startsWith("gpt-5");
}

// ── Public API ──

/**
 * Resolve the payload policy for a given model + endpoint combination.
 *
 * @param model          - The model identifier (e.g. "gpt-5.4-mini")
 * @param contextWindow  - The model's context window in tokens
 * @param isCodexEndpoint - True when hitting chatgpt.com/backend-api/codex
 */
export function resolvePayloadPolicy(params: {
  model: string;
  contextWindow: number;
  isCodexEndpoint: boolean;
}): CodexPayloadPolicy {
  const { model, contextWindow, isCodexEndpoint } = params;

  // Compact at 70% of context window, minimum 1000 tokens
  const compactThreshold = Math.max(1000, Math.floor(contextWindow * 0.7));

  if (isCodexEndpoint) {
    // Codex endpoint: store must be false, reasoning high for reliable tool use
    return {
      shouldIncludeReasoning: supportsReasoning(model),
      reasoningEffort: "high",
      reasoningSummary: "auto",
      shouldIncludeStore: true,
      storeValue: false, // Required by Codex endpoint
      compactThreshold,
      shouldUseServerCompaction: false, // Codex endpoint has no server compaction
    };
  }

  if (isCodexModel(model)) {
    // Regular OpenAI API with a Codex-class model
    return {
      shouldIncludeReasoning: supportsReasoning(model),
      reasoningEffort: "high",
      reasoningSummary: "auto",
      shouldIncludeStore: true,
      storeValue: true,
      compactThreshold,
      shouldUseServerCompaction: true,
    };
  }

  // Non-OpenAI proxy or generic model — strip reasoning, no store
  return {
    shouldIncludeReasoning: false,
    reasoningEffort: "medium",
    reasoningSummary: "concise",
    shouldIncludeStore: false,
    storeValue: false,
    compactThreshold,
    shouldUseServerCompaction: false,
  };
}

/**
 * Apply the resolved policy to a request body (mutates in place).
 *
 * Adds or strips the reasoning, store, and include fields
 * based on what the endpoint actually supports.
 */
export function applyPayloadPolicy(
  body: Record<string, unknown>,
  policy: CodexPayloadPolicy,
): void {
  // Reasoning block
  if (policy.shouldIncludeReasoning) {
    body.reasoning = {
      effort: policy.reasoningEffort,
      summary: policy.reasoningSummary,
    };
    // Include encrypted reasoning content for replay
    body.include = ["reasoning.encrypted_content"];
  } else {
    delete body.reasoning;
    // Remove reasoning from include array if present
    if (Array.isArray(body.include)) {
      body.include = (body.include as string[]).filter(
        (s) => !s.startsWith("reasoning."),
      );
      if ((body.include as string[]).length === 0) delete body.include;
    }
  }

  // Store field
  if (policy.shouldIncludeStore) {
    body.store = policy.storeValue;
  } else {
    delete body.store;
  }
}
