import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { compactionTriggers } from "./compaction-policy.js";
import { effectiveContextWindow, type AnthropicTransport } from "./effective-window.js";
import { requestBudgetTokens } from "./output-reserve.js";
import { anchoredTotalTokens, totalTokens, type TokenAnchor } from "./token-estimation.js";

export interface ContextStatus {
  usedTokens: number;
  /** The tokens a request may use: the window less the reply's reserve. */
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
 *  message-based estimate above.
 *
 *  Fullness is measured against the window LESS the reply's reserve
 *  (output-reserve.ts) — the budget the openai-compat preflight refuses
 *  against. Against the whole window, a local thinking model at 32,768 (reserve
 *  4,096) was refused at 87.5% while compaction waited for 90%, so every turn
 *  in between spent one refused round before compacting. */
export function contextStatusForTokens(
  usedTokens: number,
  model: string,
  transport?: AnthropicTransport,
): ContextStatus {
  const maxTokens = requestBudgetTokens(model, effectiveContextWindow(model, transport));
  const percentage = Math.round((usedTokens / maxTokens) * 100);

  let level: ContextStatus["level"] = "ok";
  let shouldCompact = false;
  let forceCompact = false;

  // The bands come from the user's "Compact at" (compaction-policy.ts).
  const { warningAt, compactAt, criticalAt } = compactionTriggers();

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
