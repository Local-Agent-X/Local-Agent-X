/**
 * Diagnostic classification of why a Codex or Anthropic API response ended.
 *
 * The two HTTP clients (codex-client/stream-parse.ts,
 * anthropic-client/stream-api.ts) classify every response and log anything
 * that is not a normal completion, so an empty reply in the server log says
 * WHY — content moderation, token limit, reasoning timeout, a soft refusal in
 * the text. It is a log line, not a decision: retries, refusals and the
 * continue-vs-stop signal the loop acts on are owned by the adapters
 * (canonical-loop/adapters/model-stop.ts, transport-retry.ts). Codex also
 * attaches the result to its usage as the "response.completed was seen"
 * marker (codex-client/index.ts).
 */

import { createLogger } from "./logger.js";
const logger = createLogger("response-classifier");

// Refusal-text detector: matches the common shapes of soft refusals that
// arrive with a normal stop_reason (end_turn / stop) and look like a
// completed response to the API but are functionally a content-filter.
// Conservative on purpose — only fires on short responses that LEAD with a
// refusal pattern, so a long answer that happens to contain "I'm sorry"
// in the middle won't be misclassified.
//
// First-person refusal openings: the model itself declining. These fire on
// their own because an answer that merely *describes* a policy cannot produce
// them.
const REFUSAL_PATTERNS: RegExp[] = [
  /^i (?:cannot|can'?t|will not|won'?t|am unable to|am not able to|won'?t be able to)\s+(?:help|assist|comply|do that|provide|generate|write|create|produce|engage|continue|fulfill|complete)/i,
  /^i'?m (?:sorry|afraid|unable)[,.]?\s+(?:but\s+)?i\s+(?:cannot|can'?t|won'?t|am not able)/i,
  /^i (?:apologize|must decline|have to decline|need to decline)/i,
  /^(?:sorry|unfortunately)[,.]?\s+(?:but\s+)?i\s+(?:cannot|can'?t|won'?t|am unable|am not able)/i,
  /^i (?:cannot|can'?t) (?:in good conscience|ethically|safely|responsibly)/i,
];

// Policy-mention clauses. On their OWN these are DESCRIPTIVE — a legitimate
// answer ABOUT a policy ("content that violates the content policy is removed
// automatically; you can appeal within 30 days") contains them but is not a
// refusal. They only signal a refusal when the SAME response also carries
// first-person declining framing (see FIRST_PERSON_DECLINE) — i.e. the model
// tying the policy to its own refusal ("...so I won't be able to help").
// Matching a bare policy mention here would wrongly log a completed answer
// as content_filter (HE-9). "terms" was dropped
// deliberately — "violates the terms" is almost always descriptive.
const POLICY_MENTION_PATTERNS: RegExp[] = [
  /\bagainst (?:my|the) (?:guidelines|policies|programming|principles|values)\b/i,
  /\bviolates? (?:my|the) (?:guidelines|policies|content policy|usage policy)\b/i,
];

// First-person declining framing: the model saying IT won't/can't proceed.
// Deliberately excludes a bare "I'm sorry" (an apology is not a refusal) and
// all second/third-person constructions ("you can appeal", "content is
// removed"), so a descriptive policy answer never satisfies it.
const FIRST_PERSON_DECLINE =
  /\bi\s+(?:cannot|can'?t|will not|won'?t|am unable to|am not able to|won'?t be able to|must decline|have to decline|need to decline|refuse to|am not going to|do not feel comfortable|don'?t feel comfortable)\b/i;

export interface RefusalDetection {
  isRefusal: boolean;
  pattern?: string;
  snippet?: string;
}

export function detectRefusalText(text: string | undefined | null): RefusalDetection {
  if (!text) return { isRefusal: false };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { isRefusal: false };
  // Long responses that happen to mention policies in the middle are usually
  // legitimate answers. Cap at 600 chars to bias toward true refusals.
  if (trimmed.length > 600) return { isRefusal: false };
  const head = trimmed.slice(0, 400);
  for (const re of REFUSAL_PATTERNS) {
    const m = head.match(re);
    if (m) {
      return { isRefusal: true, pattern: re.source, snippet: m[0].slice(0, 120) };
    }
  }
  // Policy-mention clauses only count as a refusal when the model is also
  // declining in first person. Without that co-signal the text is describing
  // a policy, not refusing — flagging it would misreport a completed answer.
  if (FIRST_PERSON_DECLINE.test(head)) {
    for (const re of POLICY_MENTION_PATTERNS) {
      const m = head.match(re);
      if (m) {
        return { isRefusal: true, pattern: re.source, snippet: m[0].slice(0, 120) };
      }
    }
  }
  return { isRefusal: false };
}

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
  responseText?: string;        // raw text, used for soft-refusal detection
  providerModerates?: boolean;  // false = provider does no server-side moderation (local/self-hosted); a zero-token empty is transient, not a filter
}): ClassificationResult {
  const { hasText, hasToolCalls, outputTypes = [], status, inputTokens = 0, outputTokens = 0, responseText, providerModerates } = opts;

  if (hasToolCalls) {
    return { type: "tool_called", explanation: "Model called one or more tools" };
  }

  if (hasText) {
    const refusal = detectRefusalText(responseText);
    if (refusal.isRefusal) {
      return {
        type: "content_filter",
        rawReason: status,
        explanation: `Model refused via text: "${refusal.snippet}"`,
        meta: { refusalPattern: refusal.pattern },
      };
    }
    return { type: "completed", explanation: `Normal completion (${outputTokens} output tokens)`, rawReason: status };
  }

  // Empty response — need to figure out why
  if (status === "incomplete" || status === "failed") {
    return {
      type: "error",
      rawReason: status,
      explanation: `Response marked ${status} — likely a server-side issue`,
    };
  }

  // Output contains only reasoning items? That means Codex thought but didn't respond.
  // Usually caused by reasoning_effort timeout or excessive system prompt + tools.
  if (outputTypes.length > 0 && outputTypes.every(t => t === "reasoning")) {
    return {
      type: "reasoning_timeout",
      rawReason: "reasoning-only output",
      explanation: "Model reasoned but didn't produce output. Likely: prompt too heavy, reasoning_effort too high, or token budget exhausted by reasoning.",
      meta: { inputTokens, outputTokens, outputTypes },
    };
  }

  // Zero tokens in AND out. On a MODERATING provider this usually means content
  // moderation blocked the input silently. But a non-moderating / local
  // provider (Ollama, llama.cpp, self-hosted) has no filter to trip — a zero-
  // token empty there is a transient stream failure, so classify it as
  // "empty" instead of blaming a content filter that does not exist.
  if (inputTokens === 0 && outputTokens === 0) {
    if (providerModerates === false) {
      return {
        type: "empty",
        explanation: "Zero tokens on a non-moderating provider — transient empty stream",
        meta: { inputTokens, outputTokens },
      };
    }
    return {
      type: "content_filter",
      explanation: "Zero tokens processed — likely content moderation blocked the request before generation",
    };
  }

  // Output tokens were consumed but nothing came back — reasoning timeout variant
  if (outputTokens > 0) {
    return {
      type: "reasoning_timeout",
      explanation: `Model consumed ${outputTokens} tokens on reasoning but produced no visible output`,
      meta: { inputTokens, outputTokens },
    };
  }

  return {
    type: "empty",
    rawReason: status,
    explanation: "Model returned empty response for unknown reason",
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
  responseText?: string;        // raw text, used for soft-refusal detection
}): ClassificationResult {
  const { hasText, hasToolCalls, stopReason, inputTokens = 0, outputTokens = 0, errorMessage, responseText } = opts;

  if (errorMessage) {
    if (errorMessage.includes("429") || /rate.?limit/i.test(errorMessage)) {
      return { type: "rate_limit", rawReason: errorMessage, explanation: "Rate limit exceeded" };
    }
    return { type: "error", rawReason: errorMessage, explanation: errorMessage };
  }

  switch (stopReason) {
    case "tool_use":
      return { type: "tool_called", rawReason: stopReason, explanation: "Model called a tool" };
    case "end_turn":
    case "stop_sequence":
      if (hasText) {
        const refusal = detectRefusalText(responseText);
        if (refusal.isRefusal) {
          return {
            type: "content_filter",
            rawReason: stopReason,
            explanation: `Model refused via text: "${refusal.snippet}"`,
            meta: { refusalPattern: refusal.pattern },
          };
        }
        return { type: "completed", rawReason: stopReason, explanation: `Normal completion (${outputTokens} tokens)` };
      }
      return { type: "empty", rawReason: stopReason, explanation: "Model finished normally but produced no content" };
    case "max_tokens":
      return { type: "token_limit", rawReason: stopReason, explanation: "Response was cut off at max_tokens" };
    case "refusal":
      return { type: "content_filter", rawReason: stopReason, explanation: "Model refused the request (content policy)" };
  }

  if (hasToolCalls) return { type: "tool_called", explanation: "Model called a tool" };
  if (hasText) return { type: "completed", explanation: "Normal completion" };

  return {
    type: "empty",
    rawReason: stopReason,
    explanation: "No content, no tool calls, no stop reason",
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
