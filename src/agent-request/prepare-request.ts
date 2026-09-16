// Per-turn agent-request preparation pipeline. Thin orchestrator — each
// numbered step delegates to a focused module under ./prepare-request/*.
//
// Long-task routing happens in chat.ts via Fix E — it routes Codex long
// tasks to the worker pool with a fresh context, NOT to a different
// provider. Auto-falling-back to Anthropic was the wrong call: it
// defeated the worker pool's whole purpose, surprised users with
// unexpected provider switches, and never validated that workers can
// make Codex perform on long tasks. Workers + fresh context IS the fix.

import { checkpointedHistory } from "../context-manager/checkpoint-history.js";
import { effectiveContextWindow } from "../context-manager/effective-window.js";
import { sanitizeHistory } from "../providers/sanitize.js";
import type { CheckpointedHistory } from "../context-manager/checkpoint-history.js";
import { processAttachments } from "./attachments.js";
import type { AgentRequestInput, ForcedToolChoice, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { noteResolvedAuthSource, noteResolvedModel } from "../cost-tracker.js";
import { providerUndercallsTools } from "../providers/provider-ids.js";
import { explicitTargetPin } from "./target-pin.js";
import { createLogger } from "../logger.js";

import { buildContext, isTrivialToolRequest } from "./prepare-request/build-context.js";
import { selectTools, type ToolSelectionResult } from "./prepare-request/tool-selection.js";
import { isSlashCommandExpansion } from "../slash-commands.js";
import { detectAndBoostCurate } from "./prepare-request/curate-nudge.js";
import { buildSystemPromptWithTelemetry } from "./prepare-request/build-system-prompt.js";
import { createPromptTelemetry } from "../prompt-telemetry.js";
import { appendSystemPromptSection } from "../context/system-prompt-builder.js";

const logger = createLogger("agent-request.prepare-request");

const RECALL_TOOL = "search_past_sessions";

/**
 * Whether to force the cross-session recall tool on turn 0. Pure so the
 * decision (4 gates + intent-force precedence) is testable without the
 * prepare-request pipeline. Forces only when: nothing stronger already pinned
 * a tool, the known-projects scanner found prior content, the provider
 * under-calls tools (Grok et al), and the recall tool is actually available
 * this turn.
 */
export function shouldForceRecallSearch(opts: {
  toolAlreadyForced: boolean;
  knownProjectsFound: boolean;
  provider: string;
  toolNames: readonly string[];
}): boolean {
  return (
    !opts.toolAlreadyForced &&
    opts.knownProjectsFound &&
    providerUndercallsTools(opts.provider) &&
    opts.toolNames.includes(RECALL_TOOL)
  );
}

export async function prepareAgentRequest(input: AgentRequestInput): Promise<PreparedAgentRequest> {
  // Per-step timing logs. Added 2026-05-27 after IDE-mode chat turns wedged
  // somewhere inside this pipeline with zero breadcrumbs: only the entry
  // [retry] log fired, then nothing until server restart. Tag each step
  // with the sessionId slice so IDE vs chat hangs are distinguishable.
  const sessTag = input.sessionId.slice(0, 16);
  const stepStart = (label: string): (() => void) => {
    const t = Date.now();
    logger.info(`[step] ${label} START sess=${sessTag}`);
    return () => logger.info(`[step] ${label} ${Date.now() - t}ms sess=${sessTag}`);
  };

  // 1. Resolve provider + keys
  let end = stepStart("resolveProvider");
  const resolved = await resolveProvider(
    input.config, input.secretsStore, input.dataDir,
    input.providerOverride,
    input.modelOverride,
  );
  end();
  // Record the resolved billing mode + model process-wide so the spend cap can
  // tell a flat-rate subscription (oauth) from a real per-call API key (it must
  // not block a subscriber whose per-call cost is zero) and apply a per-model
  // cap to the model actually in use.
  noteResolvedAuthSource(resolved.authSource);
  noteResolvedModel(resolved.model);

  // 2. Sanitize, then apply the session's compaction checkpoint.
  //
  // This used to keep the last N ROWS and slide the cut every message, which
  // re-shaped the request prefix on a conversation that had not changed — the
  // provider cache missed every turn and a local runtime re-prefilled the whole
  // history. The checkpoint summarises the old part ONCE and reuses those exact
  // bytes until the tail has grown enough to be worth re-cutting
  // (context-manager/checkpoint-history.ts). A manual /api/compact still
  // arrives as a leading `system` row in sessionMessages and is left alone.
  end = stepStart("checkpointHistory");
  const sanitized = sanitizeHistory(input.sessionMessages);
  const checkpointed: CheckpointedHistory = input.maxHistory
    ? { messages: sanitized.slice(-input.maxHistory) } // explicit caller cap (voice, sub-agents)
    : await checkpointedHistory(sanitized, { compactionCheckpoint: input.compactionCheckpoint }, effectiveContextWindow(resolved.model));
  const cleanHistory = checkpointed.messages;
  end();

  // 3. Tool selection (tier filter + RAG re-rank + explicit build routes). Must
  // run before build-context so we know the tier (weak-tier context strip) and
  // before system-prompt build so an explicit build route's directive lands.
  //
  // Lean callers (voice) override tools + prompt downstream, so selection is
  // wasted work on their critical path. Skip it; just compute the tier (cheap,
  // sync) which build-context still needs for the weak-model strip.
  let toolSel: ToolSelectionResult;
  if (input.leanPrep) {
    const { classifyModel } = await import("../model-tiers.js");
    toolSel = {
      tools: [],
      tier: classifyModel(resolved.model) as ToolSelectionResult["tier"],
      productBuildTurn: null,
      isBridge: false,
    };
  } else {
    // A slash-command methodology (e.g. /app-build) runs across MANY turns, but
    // only its FIRST turn carries the marker. Treat the whole session as
    // methodology-active once ANY prior user turn was a slash-command expansion.
    const priorMethodology = cleanHistory.some(
      (m) => m.role === "user" && typeof m.content === "string" && isSlashCommandExpansion(m.content),
    );
    end = stepStart("selectTools");
    toolSel = await selectTools({
      message: input.message,
      sessionId: input.sessionId,
      channel: input.channel,
      allAgentTools: input.allAgentTools,
      bridgeTools: input.bridgeTools,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.model,
      priorMethodology,
    });
    end();
  }

  // 4. Build per-turn memory + context (skip heavy parts for bridges/cron).
  // The memory pipeline runs for every provider — the orchestrator's
  // grounding signals help Codex the same way they help Claude.
  end = stepStart("buildContext");
  const isCodexProvider = resolved.provider === "codex";
  const ctx = await buildContext({
    message: input.message,
    sessionId: input.sessionId,
    sessionMessages: input.sessionMessages,
    memoryManager: input.memoryManager,
    attachments: input.attachments,
    skipMemory: input.skipMemory,
    isCodexProvider,
    isTrivialToolRequest: isTrivialToolRequest(input.message),
    tier: toolSel.tier,
    resolvedModel: resolved.model,
  });
  end();

  // 5. Memory-curate nudge detection (Stage 1 regex + Stage 2 LLM). Its
  // RETURN value is empty unless LAX_MEMORY_INPROMPT_NUDGE=1; its only other
  // effect is a per-session boost counter the (post-reply) end-of-turn pass
  // reads. So awaiting it just added ~1.5-2s of pre-model latency for nothing
  // user-visible. Fire-and-forget by default; the boost lands long before
  // end-of-turn. Only block on it when the in-prompt nudge is actually on.
  // Lean callers (voice) skip it entirely.
  let memoryCurateBlock = "";
  if (!input.leanPrep) {
    const curateInput = {
      message: input.message,
      sessionMessages: input.sessionMessages,
      sessionId: input.sessionId,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.model,
      resolvedApiKey: resolved.apiKey,
    };
    if (process.env.LAX_MEMORY_INPROMPT_NUDGE === "1") {
      end = stepStart("detectAndBoostCurate");
      memoryCurateBlock = await detectAndBoostCurate(curateInput);
      end();
    } else {
      void detectAndBoostCurate(curateInput).catch(() => {});
    }
  }

  // 6. Build the final system prompt (base + blocks + provider rider +
  // explicit build-route directive if applicable).
  end = stepStart("buildSystemPrompt");
  const promptBuild = await buildSystemPromptWithTelemetry({
    channel: input.channel,
    message: input.message,
    sessionId: input.sessionId,
    config: input.config,
    memoryIndex: input.memoryIndex,
    integrations: input.integrations,
    allAgentTools: input.allAgentTools,
    // The tools actually loaded this turn — drives the deferred-tool manifest
    // (allAgentTools − loadedTools) so the model can tool_search anything the
    // filtered schema omits. This is the discovery half of the lazy-load flip.
    loadedTools: toolSel.tools,
    systemPromptOverride: input.systemPromptOverride,
    bridgeContext: input.bridgeContext,
    resolvedProvider: resolved.provider,
    resolvedModel: resolved.model,
    contextBlock: ctx.contextBlock,
    relevantMemories: ctx.relevantMemories,
    smartContext: ctx.smartContext,
    memoryContext: ctx.memoryContext,
    memoryNotifications: ctx.notifications,
    memoryCurateBlock,
    buildTurnDirective: toolSel.productBuildTurn?.directive,
  });
  end();

  // 7. Process attachments. Images become message image-blocks; non-image files
  // (PDF/doc/etc.) get a system-prompt note handing the model the readable
  // "/uploads/<f>" PATH. One tested unit (attachments.ts) owns this — it used to
  // be inline and silently dropped non-images, 404'ing every PDF/doc upload.
  const { images, fileAttachmentNote } = processAttachments(input.attachments, input.uploadsDir);
  const sectionAwarePrompt = {
    systemPrompt: promptBuild.prompt,
    renderedPromptSections: [...promptBuild.renderedSections],
  };
  // Protocol-load notice. Appended here rather than folded into smartContext
  // because smartContext is fenced by asRecalledData as untrusted DATA, and a
  // "load this protocol" nudge is an instruction. buildContext has already
  // wrapped it with harnessNotice — the same first-party format the file-access
  // grounding and turn directives use. Degradable, and ranked LAST in the
  // kill order (context/prompt-degradation.ts) so retrieval is the final thing
  // a constrained local profile gives up rather than nearly the first.
  appendSystemPromptSection(sectionAwarePrompt, {
    id: "learned-protocol",
    label: "Learned Workflow",
    type: "dynamic",
    policy: "degradable",
    text: ctx.protocolNotice,
  });
  appendSystemPromptSection(sectionAwarePrompt, {
    id: "file-attachments",
    label: "File Attachments",
    type: "dynamic",
    policy: "required",
    text: fileAttachmentNote,
  });
  const { systemPrompt, renderedPromptSections } = sectionAwarePrompt;
  const promptTelemetry = createPromptTelemetry({
    profile: "full",
    provider: resolved.provider,
    model: resolved.model,
    authSource: resolved.authSource,
    prompt: systemPrompt,
    tools: toolSel.tools,
    allToolCount: input.allAgentTools.length,
    historyMessageCount: cleanHistory.length,
    sections: renderedPromptSections.map((section) => section.measurement),
  });

  // 8. tool_choice pin for an EXPLICIT build route only (/app-build kickoff,
  // a resolved Product Build continuation action). Nothing guessed from the
  // message's wording pins a tool.
  let toolChoice: ForcedToolChoice | undefined;
  const forcedName = toolSel.forcedToolName;
  if (forcedName) {
    if (toolSel.tools.some(t => t.name === forcedName)) {
      toolChoice = { type: "tool", name: forcedName };
      logger.info(`[build-route] forcing ${forcedName} (reason="${toolSel.productBuildTurn?.reason ?? "resolved route"}")`);
    } else {
      logger.warn(`[build-route] ${forcedName} is not in this turn's tool list — skipping force`);
    }
  }

  // Tool-shy recall force. Grok (and any provider that under-calls tools)
  // ignores the known-projects recall NUDGE and answers thin instead of
  // fetching the prior content. When the scanner DID find prior content and
  // nothing stronger already pinned a tool, force one search_past_sessions on
  // turn 0 so the recall actually happens. Strong providers self-call and are
  // left alone. The adapter releases the pin after turn 0.
  if (shouldForceRecallSearch({
    toolAlreadyForced: !!toolChoice,
    knownProjectsFound: ctx.knownProjectsFound,
    provider: resolved.provider,
    toolNames: toolSel.tools.map(t => t.name),
  })) {
    toolChoice = { type: "tool", name: RECALL_TOOL };
    logger.info(`[recall-force] ${resolved.provider} under-calls tools + known project in message — forcing ${RECALL_TOOL}`);
  }

  return {
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    model: resolved.model,
    targetPin: explicitTargetPin(input.providerOverride, input.modelOverride),
    codexApiKey: resolved.codexApiKey,
    customBaseURL: resolved.customBaseURL,
    systemPrompt,
    tools: toolSel.tools,
    cleanHistory,
    ...(checkpointed.newCheckpoint ? { newCheckpoint: checkpointed.newCheckpoint } : {}),
    images,
    temperature: resolved.temperature,
    maxIterations: resolved.maxIterations,
    reasoningEffort: resolved.reasoningEffort,
    authSource: resolved.authSource,
    // Carried verbatim: `provider`/`model` above already describe the FALLBACK,
    // so without this the caller has no way to tell a rerouted turn from one
    // that ran on exactly what was asked for.
    providerSwitch: resolved.providerSwitch,
    toolChoice,
    promptTelemetry,
    renderedPromptSections,
    localModelCapabilityProfile: null,
  };
}
