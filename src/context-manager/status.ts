import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { isCodexModel, lookupContextWindow } from "./model-windows.js";
import { totalTokens } from "./token-estimation.js";

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
  model: string
): ContextStatus {
  const maxTokens = lookupContextWindow(model);
  const usedTokens = totalTokens(messages);
  const percentage = Math.round((usedTokens / maxTokens) * 100);

  let level: ContextStatus["level"] = "ok";
  let shouldCompact = false;
  let forceCompact = false;

  // Per-provider thresholds. Codex compacts much earlier because its long-
  // context agentic reasoning falls apart before the nominal limit hits.
  // Anthropic keeps the previous (looser) thresholds since it stays focused.
  const isCodex = isCodexModel(model);
  const warningAt = isCodex ? 25 : 60;
  const compactAt = isCodex ? 35 : 75;
  const criticalAt = isCodex ? 55 : 90;

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
