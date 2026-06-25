// Tool selection pipeline: intent classifier → filter → tier-shrink → RAG
// re-rank. The intent verdict drives BOTH the filter narrowing and the
// later tool_choice forcing in the orchestrator, so this module computes
// the verdict and exposes it alongside the final tool list.

import type { ToolDefinition } from "../../types.js";
import { filterToolsForMessage } from "../tool-filter.js";
import { classifyIntent, hasLiteralToolCall, mightNeedToolForcing, NO_SPAWN_OVERRIDE_RE } from "../../classifiers/intent-classifier.js";
import { isSlashCommandExpansion } from "../../slash-commands.js";
import { providerUndercallsTools } from "../../providers/provider-ids.js";
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
  /** True when an EARLIER turn this session was a slash-command methodology
   *  invocation (the marker only rides the first turn). Keeps intent-forcing
   *  suppressed for the whole methodology, not just its kickoff turn. */
  priorMethodology?: boolean;
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
  // A slash command (e.g. /app-build) is an EXPLICIT user-chosen workflow whose
  // injected methodology body defines how the agent works and which tools to
  // call. Classifying it as build_app and pinning tool_choice to the one-shot
  // builder overrides that methodology — the exact bug where /app-build "just
  // built the app" instead of running its spec-first, ask-questions-first intake.
  // Treat it like a literal tool call: explicit intent, so skip the classifier.
  // priorMethodology extends this across the WHOLE session — the methodology
  // spans many turns but only the first carries the marker, and without it the
  // classifier re-forces build_app on a later reply ("step 2 kicked off the build").
  const inMethodology = isSlashCommandExpansion(input.message) || input.priorMethodology === true;
  const skipClassifier =
    isBridge ||
    inMethodology ||
    NO_SPAWN_OVERRIDE_RE.test(input.message) ||
    hasLiteralToolCall(input.message) ||
    // Cheap regex pre-gate: skip the LLM classifier (a 3-8s CLI round-trip on
    // Anthropic) on ordinary conversation that can't map to a forceable
    // intent. It returned "free"/null on those turns anyway.
    !mightNeedToolForcing(input.message);
  if (!skipClassifier) {
    const t0 = Date.now();
    logger.info(`[step] classifyIntent START`);
    // Uses the user's selected provider+model. We tried pinning Sonnet on
    // Anthropic to cut classify latency (2026-06-06) but it returned null
    // (the CLI Sonnet path produced unparseable output) AND wasn't faster —
    // the real Anthropic cost was the cold CLI spawn, since fixed by
    // defaulting the warm pool on (warm-pool.ts). Reverted to the selected
    // model so verdicts are valid; the warm pool keeps the classify process
    // hot after its first call.
    try { intentVerdict = await classifyIntent(input.message); }
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
  // Strong tool-shy providers (Grok) skip build-intent NARROWING the same way
  // the Anthropic-strong path does — they reason over the broad eager-audience
  // ∪ RAG union fine, and build_app stays hard-pinned by tool_choice forcing
  // (prepare-request) when intent demands it, so dropping the soft narrowing
  // doesn't reopen the improvise-with-raw-write problem. They stay OUT of the
  // bare-allAgentTools fast path above (uncached full catalog = real per-turn
  // cost), so this is a bounded broadening, not the full inventory. Codex/OpenAI
  // strong keep the narrowing — it's load-bearing for them (comment above).
  const strongToolShy = tier === "strong" && providerUndercallsTools(input.resolvedProvider);
  let tools: ToolDefinition[];
  if (isBridge) {
    tools = input.bridgeTools;
  } else if (tier === "strong" && isAnthropicProvider) {
    tools = input.allAgentTools;
  } else {
    tools = filterToolsForMessage(input.allAgentTools, input.message, { forceBuildIntent, skipBuildIntent: inMethodology || strongToolShy });
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

  // Provider-aware tool cap — LAST, after RAG re-inflation. Tool capacity is a
  // function of (provider, tier): this only fires when the provider stricter-
  // caps than the model's own tier, i.e. Gemini-strong (its compat endpoint
  // can't take the full inventory — see toolCapTierForProvider). For every
  // other provider capTier === tier, so this is a no-op and behavior is
  // unchanged. The filter+RAG above already picked the message-relevant tools;
  // shrink preserves essentials, and we keep tool_search so the model can still
  // reach the rest (Google's "dynamic tool selection").
  const { toolCapTierForProvider } = await import("../../model-tiers.js");
  const capTier = toolCapTierForProvider(input.resolvedProvider, input.resolvedModel);
  if (!isBridge && capTier !== tier) {
    const before = tools.length;
    tools = shrinkToolsForTier(tools, capTier, input.allAgentTools);
    if (!tools.some(t => t.name === "tool_search")) {
      const ts = input.allAgentTools.find(t => t.name === "tool_search");
      if (ts) tools = [ts, ...tools];
    }
    if (tools.length !== before) {
      logger.info(`[tools] ${input.resolvedProvider} cap ${before}→${tools.length} (tier=${tier}→${capTier}; endpoint tool limit)`);
    }
  }

  return { tools, tier, intentVerdict, forceBuildIntent, isBridge };
}
