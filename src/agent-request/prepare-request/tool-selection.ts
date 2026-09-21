// Tool selection pipeline: filter → tier-shrink → RAG re-rank → session union.
//
// There is no intent classification. The user's wording never narrows the tool
// set, pins tool_choice, or injects a build directive — a classifier guessing
// "build" from "which step failed in build-4.log?" launched a background app
// build that held the local model for 30+ minutes (op-outcomes 2026-09-15).
// build_app is an ordinary tool the model chooses. Only EXPLICIT build workflows
// route tools: the /app-build slash command, and continuing a durable Product
// Build this session already has.

import type { ToolDefinition } from "../../types.js";
import type { ChannelKind } from "../types.js";
import { filterToolsForMessage } from "../tool-filter.js";
import { isSlashCommandExpansion } from "../../slash-commands.js";
import { createLogger } from "../../logger.js";
import { resolveModelProfile } from "../../local-runtimes/model-profile.js";
import {
  applyProductBuildToolRoute,
  productBuildMethodologyTurn,
  resolveProductBuildContinuationTurn,
  type ContinuationResolver,
  type ProductBuildTurn,
} from "./product-build-routing.js";

const logger = createLogger("agent-request.prepare-request.tools");

/**
 * The declared per-model tool cap, when the model has a profile. Null means
 * "use the tier's own cap" — every cloud model today, so this is confined to
 * local runtimes the same way the rest of the profile is.
 */
function profileToolCap(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return resolveModelProfile(model)?.maxToolsExposed;
}

export type Tier = "weak" | "medium" | "strong";

export interface ToolSelectionInput {
  message: string;
  sessionId: string;
  channel: ChannelKind;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  resolvedProvider: string;
  resolvedModel: string;
  /** True when an EARLIER turn this session was a slash-command methodology
   *  invocation (the marker only rides the first turn), so the methodology's
   *  tool routing holds for the whole session, not just its kickoff turn. */
  priorMethodology?: boolean;
  /** Test seam for the durable Product Build lookup. */
  continuationResolver?: ContinuationResolver;
}

export interface ToolSelectionResult {
  tools: ToolDefinition[];
  tier: Tier;
  productBuildTurn: ProductBuildTurn | null;
  forcedToolName?: string;
  isBridge: boolean;
}

// Tools that let the agent build something ITSELF — write source, run a
// compiler/dev-server, or surface the artifact. On an explicit build-workflow
// turn (/app-build, Product Build continuation) the build is owned by a
// background op; the main chat agent must NOT also build it inline. That
// dual-build bug shipped a Rust raytrace TWICE — the worker compiled it at
// apps/<id>/ while the main agent ALSO ran cargo at workspace/<id>/. Read-only
// tools (read/glob/grep) stay — they can't build.
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

// Tool names each session has already shipped. The tools array is the FIRST
// block of the prompt-cache prefix, so a per-message re-pick that drops or adds
// one tool invalidates tools + system + history for that request (measured:
// 34 of 46 full cache misses on quick chat follow-ups coincided with a changed
// tool set). Strong models get the session's union instead: the set only grows,
// so consecutive messages send byte-identical tools until a new one is needed.
const SESSION_TOOLS_MAX_SESSIONS = 500;
const sessionToolNames = new Map<string, Set<string>>();

/** Union `names` into the session's shipped-tool set. Called with each
 *  selection and with the op's final tool list (which includes tools the
 *  model loaded mid-op via tool_search). */
export function rememberSessionTools(sessionId: string, names: Iterable<string>): void {
  if (!sessionId) return;
  let known = sessionToolNames.get(sessionId);
  if (!known) {
    if (sessionToolNames.size >= SESSION_TOOLS_MAX_SESSIONS) {
      sessionToolNames.delete(sessionToolNames.keys().next().value as string);
    }
    known = new Set();
    sessionToolNames.set(sessionId, known);
  }
  for (const name of names) known.add(name);
}

export function _resetSessionToolsForTests(): void {
  sessionToolNames.clear();
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

  // A slash command (e.g. /app-build) is an EXPLICIT user-chosen workflow whose
  // injected methodology body defines how the agent works and which tools to
  // call. priorMethodology extends it across the whole session — only the
  // first turn carries the marker.
  const inMethodology = isSlashCommandExpansion(input.message) || input.priorMethodology === true;
  const methodologyTurn = inMethodology
    ? productBuildMethodologyTurn(isSlashCommandExpansion(input.message))
    : null;
  const productBuildTurn = continuationTurn ?? methodologyTurn;

  // Tier gates how hard we shrink the schema. Weak/medium models are paralyzed
  // by 100+ tool catalogs (0-token responses), so they get filter → shrink →
  // RAG. Strong models keep the broad message-relevant set (filter + RAG, no
  // shrink). NOTHING ships the full uncached inventory any more: the deferred-
  // tool manifest (build-system-prompt.ts) names every UNLOADED tool so the
  // model can reach it via tool_search, which removes the reason Anthropic-
  // strong used to ship every tool every turn "so the LLM cannot fail-discover
  // a tool that exists." The tools array is the one block Anthropic prompt-
  // caches (stream-api.ts), so shipping the filtered set instead of the whole
  // catalogue shrinks the ~66s cold cache-write with it. What holds is EVERY
  // AVAILABLE TOOL IS REACHABLE — each is either loaded into the schema or named
  // in the manifest — so discoverability is preserved without the full schema
  // cost. Not the full CATALOG: a tool its available() predicate hides is
  // deliberately in neither, which is the point of the gate. The converse does
  // not hold either — `loaded` is re-derived below from the RAW catalog, so it
  // can carry an unavailable tool into the schema (fail-open, see the block at
  // the availability-gate note further down).
  const { classifyModel, shrinkToolsForTier } = await import("../../model-tiers.js");
  const tier = classifyModel(input.resolvedModel) as Tier;

  // THE PER-TOOL AVAILABILITY GATE DOES NOT RUN IN THIS FUNCTION. isToolAvailable()
  // /filterAvailableTools() (src/tools/tool-search.ts) are applied by
  // resolveToolsForRequest() and by the deferred-tool manifest in
  // build-system-prompt.ts. Neither is on this path, and two things follow:
  //
  //  - the bridge branch immediately below hands `input.bridgeTools` straight to
  //    the model, so a Telegram/WhatsApp turn is entirely ungated;
  //  - every re-derivation below (the RAG union at `input.allAgentTools.filter(...)`,
  //    the provider tool cap, the tool_search re-add, stripInlineBuildTools and
  //    applyProductBuildToolRoute) selects out of the RAW `input.allAgentTools`,
  //    so a tool the gate hid upstream can be put back into the schema. On "send
  //    an email to bob" the RAG union does exactly that with `email_send`.
  //
  // Both directions ADD tools, never remove them, so both fail OPEN: the worst
  // outcome is a tool that returns its own "not configured" error, which is the
  // behaviour that shipped before the gate existed. That is materially better
  // than the failure the gate exists to prevent — a WORKING tool going silently
  // invisible — so this is documented rather than narrowed. Filtering here would
  // convert the most heavily-branched selection path in the request pipeline
  // from fail-open to fail-closed, and every one of those branches would need
  // its own proof that it cannot drop a usable tool. If that is ever wanted, it
  // is one deliberate change with its own test matrix, not a line added here.
  let tools: ToolDefinition[];
  if (isBridge) {
    tools = input.bridgeTools;
  } else {
    tools = filterToolsForMessage(input.allAgentTools, input.message);
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
        // The union is rebuilt from the RAW catalog, which throws away the tier
        // compaction applied above. Re-apply it — INCLUDING the count cap.
        //
        // 711f2cd6 re-applied this at the union's own size (capOverride =
        // tools.length) so every re-rank pick would survive, which fixed the
        // description half and silently disabled the count half. Those are two
        // different limits: description length is a model-comprehension limit,
        // tool COUNT is a capacity limit, and the weak cap of 8 exists
        // specifically to stop 0-token paralysis. With the index warm a weak
        // model was handed 65–74 tools — more than with a cold index, so the
        // cap did the opposite of its job on exactly the turns it mattered.
        //
        // shrinkToolsForTier pulls ESSENTIAL_TOOLS_ORDER first and the
        // re-rank's picks into whatever headroom is left, so relevance still
        // decides the tail; it just stops deciding the size.
        if (tier !== "strong") tools = shrinkToolsForTier(tools, tier, input.allAgentTools, profileToolCap(input.resolvedModel));
        logger.info(`[step] tool-rag.select ${Date.now() - ragT0}ms picked=${semantic.length}`);
      } else {
        logger.info(`[tool-rag] not ready yet — shipping filtered set without RAG re-rank`);
      }
    } catch (e) {
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
    // Weak/medium sets are capped for model capacity, so only strong grows.
    // Re-derived in catalog order so the same union serializes identically.
    const known = sessionToolNames.get(input.sessionId);
    if (tier === "strong" && known) {
      const union = new Set([...known, ...tools.map(t => t.name)]);
      tools = input.allAgentTools.filter(t => union.has(t.name));
    }
    rememberSessionTools(input.sessionId, tools.map(t => t.name));
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

  // Explicit build-workflow turn: the background op owns the build, so deny the
  // main agent the tools to build it inline (the dual-build fix). Applied after
  // every other selection step so no path re-adds them.
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
    productBuildTurn,
    forcedToolName: productBuildTurn?.targetTool,
    isBridge,
  };
}
