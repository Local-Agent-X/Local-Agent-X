// Tool selection pipeline: intent classifier → filter → tier-shrink → RAG
// re-rank. The intent verdict drives BOTH the filter narrowing and the
// later tool_choice forcing in the orchestrator, so this module computes
// the verdict and exposes it alongside the final tool list.

import type { ToolDefinition } from "../../types.js";
import { filterToolsForMessage } from "../tool-filter.js";
import { classifyIntent, hasLiteralToolCall, NO_SPAWN_OVERRIDE_RE } from "../../classifiers/intent-classifier.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-request.prepare-request.tools");

export type IntentVerdict = Awaited<ReturnType<typeof classifyIntent>>;
export type Tier = "weak" | "medium" | "strong";

export interface ToolSelectionInput {
  message: string;
  channel: "web" | "telegram" | "whatsapp" | "cron" | "agent";
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  resolvedProvider: string;
  resolvedModel: string;
}

export interface ToolSelectionResult {
  tools: ToolDefinition[];
  tier: Tier;
  intentVerdict: IntentVerdict;
  forceBuildIntent: boolean;
  isBridge: boolean;
}

export async function selectTools(input: ToolSelectionInput): Promise<ToolSelectionResult> {
  const isBridge = input.channel === "telegram" || input.channel === "whatsapp";

  // Run the intent classifier UP FRONT so its verdict drives both the
  // tool-filter strip-down (here) AND the tool_choice forcing later.
  // Regex alone misses phrasings like "build a log counting app" where
  // modifiers sit between the article and the noun — the LLM classifier
  // catches those and lets us narrow tools accordingly. Failure mode
  // w/o this: full 39-tool set ships, model bypasses build_app and
  // improvises with raw write/bash/http_request.
  let intentVerdict: IntentVerdict = null;
  const skipClassifier =
    isBridge ||
    NO_SPAWN_OVERRIDE_RE.test(input.message) ||
    hasLiteralToolCall(input.message);
  if (!skipClassifier) {
    const t0 = Date.now();
    logger.info(`[step] classifyIntent START`);
    // The classifier inherits the user's CHAT model by default. On Anthropic
    // that means Opus classifies a one-word verdict in ~6s — the single
    // largest chunk of pre-model latency (measured 2026-06-06). Pin Sonnet
    // for Anthropic classification only: 4× faster, no quality loss on a
    // 4-way label, same provider (no cross-provider regression), and Sonnet
    // is allowed under the no-Haiku-for-classifiers rule. Other providers
    // already classify in 1.5-2.5s, so leave them on their selected model.
    const classifyModelOverride =
      input.resolvedProvider === "anthropic" ? "claude-sonnet-4-6" : undefined;
    try { intentVerdict = await classifyIntent(input.message, { model: classifyModelOverride }); }
    catch (e) { logger.info(`[intent] classifier threw — skipping: ${(e as Error).message}`); }
    logger.info(`[step] classifyIntent ${Date.now() - t0}ms verdict=${intentVerdict?.kind || "null"}`);
  }
  const forceBuildIntent = intentVerdict?.kind === "build_app";

  // Tier first — strong models get the full inventory (no filter, no shrink,
  // no RAG re-rank), so the LLM cannot fail-discover a tool that exists.
  // The previous slice → filter → shrink → RAG pipeline ate cycles to keep
  // the catalogue small for token-cost reasons; with Anthropic prompt
  // caching (cache_control added in the stream-api adapter), the tool
  // schemas hit cache after the first turn and the per-turn marginal cost
  // collapses to ~10% of base. OpenAI/Codex providers cache automatically.
  // Weak/medium models still need shrinking — 100+ tool catalogs paralyze
  // them into 0-token responses.
  const { classifyModel, shrinkToolsForTier } = await import("../../model-tiers.js");
  const tier = classifyModel(input.resolvedModel) as Tier;

  // Anthropic strong-tier gets the full inventory (cache_control anchor
  // in stream-api.ts amortizes the token cost across turns). Everything
  // else — including OpenAI/Codex strong — goes through filter + RAG so
  // the build-intent narrowing in filterToolsForMessage actually narrows
  // and the model isn't tempted to improvise with raw write/edit/bash
  // when build_app is the right call. (Earlier "128-cap with top-up"
  // path neutered the narrowing because it padded the filtered set back
  // up to 128 with the rest of the catalogue.)
  const isAnthropicProvider = input.resolvedProvider === "anthropic";
  let tools: ToolDefinition[];
  if (isBridge) {
    tools = input.bridgeTools;
  } else if (tier === "strong" && isAnthropicProvider) {
    tools = input.allAgentTools;
  } else {
    tools = filterToolsForMessage(input.allAgentTools, input.message, { forceBuildIntent });
    if (tier !== "strong") {
      const before = tools.length;
      tools = shrinkToolsForTier(tools, tier, input.allAgentTools);
      if (tools.length !== before) {
        logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${input.resolvedModel} (${tools.map(t => t.name).join(",")})`);
      }
    }
    try {
      const { getToolRAG } = await import("../../tool-rag.js");
      const rag = getToolRAG();
      // Do NOT call rag.build() from the chat path — embedding 167 tools
      // serially on CPU-only Ollama is 50-100s. Pre-warm at server boot
      // (src/server/index.ts) is the only builder. If a chat beats the
      // pre-warm we just ship without RAG re-rank this turn.
      if (rag.isReady) {
        const ragT0 = Date.now();
        logger.info(`[step] tool-rag.select START`);
        const semantic = await rag.select(input.message, input.allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: input.allAgentTools.filter(t => t.audiences?.includes("main-chat")).map(t => t.name),
          includeMCP: true,
        });
        const union = new Set(tools.map(t => t.name));
        for (const t of semantic) {
          union.add(t.name);
        }
        tools = input.allAgentTools.filter(t => union.has(t.name));
        logger.info(`[step] tool-rag.select ${Date.now() - ragT0}ms picked=${semantic.length}`);
      } else {
        logger.info(`[tool-rag] not ready yet — shipping filtered set without RAG re-rank`);
      }
    } catch (e) {
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
  }

  return { tools, tier, intentVerdict, forceBuildIntent, isBridge };
}
