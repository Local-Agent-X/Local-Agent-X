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
import {
  applyProductBuildToolRoute,
  productBuildMethodologyTurn,
  resolveProductBuildContinuationTurn,
  type ContinuationResolver,
  type ProductBuildTurn,
} from "./product-build-routing.js";

const logger = createLogger("agent-request.prepare-request.tools");


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
  /** Set when this turn's system prompt will carry a LEARNED WORKFLOW nudge
   *  naming `protocol(action:"get")` for `name`. The nudge is only actionable
   *  if that tool is in the schema, and it is in neither the weak nor the
   *  medium essential set — so the nudge pulls it in, the way tool_search is
   *  kept. With the profile's `nudgeInToolDescription`, the tool's own
   *  description opens with the instruction too (EXP-16). */
  protocolSuggestion?: { name: string } | null;
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
  const { classifyModel } = await import("../../model-tiers.js");
  const { shrinkToolsForTier } = await import("../../tools/tier-tool-set.js");
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
    // EXP-18/EXP-24: "essentials" = the tier's essential set plus the message's
    // picks, undo-paired; "catalog" pins every main-chat tool. An unprofiled
    // model — every frontier model without a profile — is catalog, exactly as
    // before. A strong model whose profile opts into essentials is shrunk to
    // the MEDIUM tier's essential set as its base: the strong tier never had a
    // shrink of its own (it lazy-loads from the manifest instead), and the
    // medium set is the one the local campaign measured.
    const { modelToolMembership } = await import("../../local-runtimes/model-profile.js");
    const membership = modelToolMembership(input.resolvedModel);
    const shrinkTier: Tier | null = tier !== "strong" ? tier : membership === "essentials" ? "medium" : null;
    if (shrinkTier) {
      const before = tools.length;
      tools = shrinkToolsForTier(tools, shrinkTier, input.allAgentTools);
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
        // EXP-18: what the index may add. "catalog" pins every main-chat tool,
        // which re-adds the whole catalog the shrink just cut (65–77 on the
        // wire, ~19k tokens on the 27B). "essentials" pins the tier set the
        // shrink produced and lets the index add only the message's picks.
        const semantic = await rag.select(input.message, input.allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: membership === "essentials"
            ? tools.map(t => t.name)
            : input.allAgentTools.filter(t => t.audiences?.includes("main-chat")).map(t => t.name),
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
    // The session's union: the set only grows, so consecutive messages send
    // byte-identical tools until a new one is needed. Strong models always;
    // a local model when its profile routes tools per mission (EXP-12: on the
    // local wire the tool schemas render after the system text, so a set that
    // changes 74→75→74 across messages re-prefilled the whole prompt at every
    // arrival — 30-37k tokens, measured). Re-derived in catalog order so the
    // same union serializes identically.
    const { modelToolRouting } = await import("../../local-runtimes/model-profile.js");
    const sticky = tier === "strong" || modelToolRouting(input.resolvedModel) === "mission";
    const known = sessionToolNames.get(input.sessionId);
    if (sticky && known) {
      const union = new Set([...known, ...tools.map(t => t.name)]);
      tools = input.allAgentTools.filter(t => union.has(t.name));
    }
    // The tier's DESCRIPTION compaction at the final set's own size, so every
    // pick survives (711f2cd6). Applied after the union so the bytes are a
    // function of the set alone.
    //
    // This deliberately does NOT enforce the tier's tool COUNT, and that
    // is a measured decision, not an oversight. EXP-7 through 7d
    // (2026-09-21, docs/harness/HARNESS_LOG.md) enforced it four ways.
    // It cut input tokens 62% on qwen3:8b and 34% on qwen3.6:27b — and
    // cost the 8B 3-8 cases in every variant (20/63 -> 14, 17, 15, 12) and
    // failed the 27B's unsafe_action gate in all three runs that measured
    // it (0 -> 2, 1, 2): a capped set kept a guessable `delete_file`
    // reachable and lost the product-specific `restore_file`. The saving is
    // real; nothing here can yet choose WHICH few tools a message needs.
    // EXP-18's invariant, after every step that can add or drop a tool: a set
    // never carries a destructive tool without the tool that undoes it. EXP-7
    // failed the gate on exactly this — a capped set kept delete_file and lost
    // restore_file. Cheap, and it runs for every tier so "catalog" membership
    // cannot regress into the same shape either.
    const { withUndoCounterparts } = await import("../../tools/undo-pairs.js");
    tools = withUndoCounterparts(tools, input.allAgentTools);
    if (shrinkTier) tools = shrinkToolsForTier(tools, shrinkTier, input.allAgentTools, tools.length);
    // A nudge that names a tool the model does not have is dead text (the
    // tier-tool-set header records exactly that failure for tool_search). Put
    // `protocol` in the schema whenever the prompt will say to call it —
    // AFTER the shrink, because the shrink refills from the essential list
    // and evicts any non-essential pick on the weak tier — and keep it for
    // the rest of a mission-routed session: the nudge is per message, the
    // need it answers is not, and dropping the tool on the next turn would
    // cost a second re-prefill for nothing. The session memory below records
    // it like any other pick; the shrink would evict it again next turn, so
    // the guard reads the memory too.
    const wantsProtocol = !!input.protocolSuggestion || (sticky && !!known?.has("protocol"));
    if (wantsProtocol && !tools.some((t) => t.name === "protocol")) {
      const protocolTool = input.allAgentTools.find((t) => t.name === "protocol");
      // Same tier compaction the shrink gave every other tool in the set.
      if (protocolTool) tools = [...tools, ...(tier === "strong" ? [protocolTool] : shrinkToolsForTier([protocolTool], tier))];
    }
    rememberSessionTools(input.sessionId, tools.map(t => t.name));
    // What actually ships. The "Shrunk a→b" line above is the pre-union tier
    // set; for two months it read as the wire count while 65–77 tools went
    // out. This is the number to trust.
    logger.info(`[tools] on the wire: ${tools.length} for ${tier} model ${input.resolvedModel} (${tools.map(t => t.name).join(",")})`);
  }

  // Provider-aware tool cap — LAST, after RAG re-inflation. Tool capacity is a
  // function of (provider, tier): this only fires when the provider stricter-
  // caps than the model's own tier, i.e. Gemini-strong (its compat endpoint
  // can't take the full inventory — see toolCapTierForProvider). For every
  // other provider capTier === tier, so this is a no-op and behavior is
  // unchanged. The filter+RAG above already picked the message-relevant tools;
  // shrink preserves essentials, and we keep tool_search so the model can still
  // reach the rest (Google's "dynamic tool selection").
  const { toolCapTierForProvider, GEMINI_STRONG_TOOL_CAP } = await import("../../tools/tier-tool-set.js");
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

  // EXP-16: the nudge where a small model actually looks. The system-prompt
  // notice is the tail of a ~64k-char prompt; the 8B saw it, had the tool,
  // and still reasoned from its tool list ("deploying to Vercel isn't
  // listed"). On a nudge turn the `protocol` tool's description opens with
  // the same instruction. Last step on purpose: it rewrites one tool's bytes
  // for THIS turn only (the session set remembers names, not bytes), so the
  // description reverts on the next turn and the cost is one re-prefill each
  // way — an experiment's price, recorded in the profile flag that gates it.
  if (input.protocolSuggestion && !isBridge) {
    const { modelNudgeInToolDescription } = await import("../../local-runtimes/model-profile.js");
    if (modelNudgeInToolDescription(input.resolvedModel)) {
      const name = input.protocolSuggestion.name;
      tools = tools.map((t) => t.name === "protocol"
        ? { ...t, description: `FIRST, for this request: a stored protocol "${name}" matches it — call protocol(action:"get", params:{name:"${name}"}) before any other tool, then follow it. ${t.description}` }
        : t);
    }
  }

  return {
    tools,
    tier,
    productBuildTurn,
    forcedToolName: productBuildTurn?.targetTool,
    isBridge,
  };
}
