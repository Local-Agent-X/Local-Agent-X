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
import {
  applyProductBuildToolRoute,
  productBuildMethodologyTurn,
  productBuildTurnFromIntent,
  resolveProductBuildContinuationTurn,
  type ContinuationResolver,
  type ProductBuildTurn,
} from "./product-build-routing.js";

const logger = createLogger("agent-request.prepare-request.tools");

export type IntentVerdict = Awaited<ReturnType<typeof classifyIntent>>;
export type Tier = "weak" | "medium" | "strong";

export interface ToolSelectionInput {
  message: string;
  sessionId: string;
  channel: "web" | "telegram" | "whatsapp" | "cron" | "agent";
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  resolvedProvider: string;
  resolvedModel: string;
  /** True when an EARLIER turn this session was a slash-command methodology
   *  invocation (the marker only rides the first turn). Keeps intent-forcing
   *  suppressed for the whole methodology, not just its kickoff turn. */
  priorMethodology?: boolean;
  /** Compact last-few-turns digest fed to the intent classifier as context, so
   *  "build" mid-discovery and "yes, build it" after a spec convo classify
   *  correctly instead of from the bare message. Built by buildHistoryDigest. */
  historyDigest?: string;
  /** Test seams for the two decisions owned by this canonical pipeline. */
  classifyIntentFn?: typeof classifyIntent;
  continuationResolver?: ContinuationResolver;
}

export interface ToolSelectionResult {
  tools: ToolDefinition[];
  tier: Tier;
  intentVerdict: IntentVerdict;
  forceBuildIntent: boolean;
  productBuildTurn: ProductBuildTurn | null;
  forcedToolName?: string;
  isBridge: boolean;
}

// Tools that let the agent build something ITSELF — write source, run a
// compiler/dev-server, or surface the artifact. When intent forcing pins
// build_app, the build is owned by the background app_build op (the "side
// agent"); the main chat agent must NOT also build it inline. That dual-build
// bug shipped a Rust raytrace TWICE — the worker compiled it at apps/<id>/
// while the main agent ALSO ran cargo at workspace/<id>/, producing two outputs
// and a confusing double result. The TURN DIRECTIVE asks the model not to; this
// strip is the hard guarantee across EVERY provider (the directive fired only on
// Anthropic, and the build-intent narrowing keeps bash/write/edit by design).
// Read-only tools (read/glob/grep) stay — they can't build. build_app is never
// stripped (tool_choice forcing pins it).
const INLINE_BUILD_TOOLS = new Set([
  "write", "edit", "edit_lines", "multi_edit", "bulk_replace", "bash",
  "process_start", "process_status", "process_kill",
  "send_image", "connector_create", "app_serve_backend", "self_edit",
]);

/** Remove the inline-build tools so a forced build_app turn can't ALSO build
 *  the app itself. build_app is preserved (re-added from the full catalog if a
 *  prior narrowing step dropped it) so tool_choice forcing still resolves. */
export function stripInlineBuildTools(
  tools: ToolDefinition[],
  allTools: ToolDefinition[],
): ToolDefinition[] {
  const kept = tools.filter((t) => !INLINE_BUILD_TOOLS.has(t.name));
  if (!kept.some((t) => t.name === "build_app")) {
    const buildApp = allTools.find((t) => t.name === "build_app");
    if (buildApp) return [buildApp, ...kept];
  }
  return kept;
}

export async function selectTools(input: ToolSelectionInput): Promise<ToolSelectionResult> {
  const isBridge = input.channel === "telegram" || input.channel === "whatsapp";

  // Durable Product Build state has precedence, but only on an explicit
  // continuation/status/resume turn. This keeps the main agent conversational
  // while a build runs and prevents "build another app" from adopting it.
  const continuationTurn = isBridge
    ? null
    : resolveProductBuildContinuationTurn(
        input.message,
        input.sessionId,
        input.continuationResolver,
      );

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
    continuationTurn !== null ||
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
    try {
      const classifier = input.classifyIntentFn ?? classifyIntent;
      intentVerdict = await classifier(input.message, { historyDigest: input.historyDigest });
    }
    catch (e) { logger.info(`[intent] classifier threw — skipping: ${(e as Error).message}`); }
    logger.info(`[step] classifyIntent ${Date.now() - t0}ms verdict=${intentVerdict?.kind || "null"}`);
  }
  const methodologyTurn = inMethodology
    ? productBuildMethodologyTurn(isSlashCommandExpansion(input.message))
    : null;
  const productBuildTurn = continuationTurn ?? methodologyTurn ?? productBuildTurnFromIntent(intentVerdict);
  const forceBuildIntent = productBuildTurn !== null;

  // Tier gates how hard we shrink the schema. Weak/medium models are paralyzed
  // by 100+ tool catalogs (0-token responses), so they get filter → shrink →
  // RAG. Strong models keep the broad message-relevant set (filter + RAG, no
  // shrink). NOTHING ships the full uncached inventory any more: the deferred-
  // tool manifest (build-system-prompt.ts) names every UNLOADED tool so the
  // model can reach it via tool_search, which removes the reason Anthropic-
  // strong used to ship every tool every turn "so the LLM cannot fail-discover
  // a tool that exists." The tools array is the one block Anthropic prompt-
  // caches (stream-api.ts), so shipping the filtered set instead of the whole
  // catalogue shrinks the ~66s cold cache-write with it. loaded ∪ manifested =
  // full catalog, so discoverability is preserved without the full schema cost.
  const { classifyModel, shrinkToolsForTier } = await import("../../model-tiers.js");
  const tier = classifyModel(input.resolvedModel) as Tier;

  const isAnthropicProvider = input.resolvedProvider === "anthropic";
  // Strong providers that reason fine over the broad eager ∪ RAG union skip
  // build-intent NARROWING: tool-shy providers (Grok under-calls tools, and
  // build_app stays hard-pinned by tool_choice forcing in prepare-request) AND
  // Anthropic — with the deferred manifest it can no longer fail-discover, so
  // the old full-inventory special case is gone and it takes the same filtered
  // path. Codex/OpenAI strong KEEP the narrowing — it's load-bearing (without it
  // they improvise raw write/edit/bash instead of calling build_app).
  const strongSkipNarrowing =
    tier === "strong" &&
    (providerUndercallsTools(input.resolvedProvider) || isAnthropicProvider);
  let tools: ToolDefinition[];
  if (isBridge) {
    tools = input.bridgeTools;
  } else {
    tools = filterToolsForMessage(input.allAgentTools, input.message, { forceBuildIntent, skipBuildIntent: inMethodology || strongSkipNarrowing });
    if (tier !== "strong") {
      const before = tools.length;
      tools = shrinkToolsForTier(tools, tier, input.allAgentTools);
      if (tools.length !== before) {
        logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${input.resolvedModel} (${tools.map(t => t.name).join(",")})`);
      }
    }
    try {
      const { getToolRAG } = await import("../../tools/tool-rag.js");
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
  const { toolCapTierForProvider, GEMINI_STRONG_TOOL_CAP } = await import("../../model-tiers.js");
  const capTier = toolCapTierForProvider(input.resolvedProvider, input.resolvedModel);
  if (!isBridge && capTier !== tier) {
    const before = tools.length;
    // Explicit endpoint cap, NOT the medium tier's count. The two were the same
    // number until 2026-07-15 and were silently coupled — raising medium for
    // model-capacity reasons would have pushed Gemini further past Google's
    // documented 10-20 ceiling as a side effect. Pinned so they move apart.
    tools = shrinkToolsForTier(tools, capTier, input.allAgentTools, GEMINI_STRONG_TOOL_CAP);
    if (!tools.some(t => t.name === "tool_search")) {
      const ts = input.allAgentTools.find(t => t.name === "tool_search");
      if (ts) tools = [ts, ...tools];
    }
    if (tools.length !== before) {
      logger.info(`[tools] ${input.resolvedProvider} cap ${before}→${tools.length} (tier=${tier}→${capTier}; endpoint tool limit)`);
    }
  }

  // Forced build_app turn: the background op owns the whole build, so deny the
  // main agent the tools to build it inline (the dual-build fix). Last step, so
  // it applies on every selection path — including the Anthropic-strong full
  // inventory and the Grok strong-tool-shy path that both skip the narrowing.
  if (productBuildTurn && !isBridge) {
    tools = stripInlineBuildTools(tools, input.allAgentTools);
  }

  // Exact Product Build routing is the final authority after every filter,
  // tier shrink, RAG union, provider cap, and inline-build strip. Remove all
  // sibling workflow tools and re-add only the selected target.
  if (!isBridge) {
    tools = applyProductBuildToolRoute(tools, input.allAgentTools, productBuildTurn);
  }

  return {
    tools,
    tier,
    intentVerdict,
    forceBuildIntent,
    productBuildTurn,
    forcedToolName: productBuildTurn?.targetTool,
    isBridge,
  };
}
