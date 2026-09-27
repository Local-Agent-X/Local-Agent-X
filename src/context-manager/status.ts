import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { compactionTriggersFor } from "./compaction-policy.js";
import { effectiveContextWindow, type AnthropicTransport } from "./effective-window.js";
import { anchoredTotalTokens, totalTokens, type TokenAnchor } from "./token-estimation.js";

export interface ContextStatus {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  level: "ok" | "warning" | "compact" | "critical" | "emergency";
  shouldCompact: boolean;
  forceCompact: boolean;
}

export function getContextStatus(
  messages: ChatCompletionMessageParam[],
  model: string,
  // When the caller knows the last response's REAL usage, size the context
  // from that anchor plus an estimate of only the messages appended since.
  // Omitted → pure estimate, byte-identical to the historical behavior.
  anchor?: TokenAnchor,
  // Transport the context will be SENT on. Anthropic's CLI/OAuth path serves a
  // smaller effective window than the API-rated one, so its thresholds must
  // size against that. Omitted → nominal window (historical behavior).
  transport?: AnthropicTransport,
  // The request's BASELINE token cost — system prompt + tool-schema manifest
  // (+ memory) that the adapter sends as separate params, so it never appears
  // in `messages`. Added to the estimate ONLY on the pure-estimate branch: a
  // real-usage anchor's token count already includes the baseline (it is the
  // provider's true input count), so adding it there would double-count.
  // Omitted/0 → historical behavior.
  baselineTokens = 0
): ContextStatus {
  const usedTokens = anchor
    ? anchoredTotalTokens(messages, anchor)
    : totalTokens(messages) + baselineTokens;
  return contextStatusForTokens(usedTokens, model, transport);
}

/** The status of a context already measured in tokens — the prompt a provider
 *  reported for the round it just served. Same window and bands as the
 *  message-based estimate above. */
export function contextStatusForTokens(
  usedTokens: number,
  model: string,
  transport?: AnthropicTransport,
): ContextStatus {
  const maxTokens = effectiveContextWindow(model, transport);
  const percentage = Math.round((usedTokens / maxTokens) * 100);

  let level: ContextStatus["level"] = "ok";
  let shouldCompact = false;
  let forceCompact = false;

  // Per-provider trigger bands — the policy table (compaction-policy.ts) owns
  // the values and the Codex-vs-default lane split.
  const { warningAt, compactAt, criticalAt } = compactionTriggersFor(model);

  if (percentage >= criticalAt) {
    level = "critical";
    forceCompact = true;
    shouldCompact = true;
  } else if (percentage >= compactAt) {
    level = "compact";
    shouldCompact = true;
  } else if (percentage >= warningAt) {
    level = "warning";
  }

  return { usedTokens, maxTokens, percentage, level, shouldCompact, forceCompact };
}
