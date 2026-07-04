// Per-turn agent-request preparation pipeline. Thin orchestrator — each
// numbered step delegates to a focused module under ./prepare-request/*.
//
// Long-task routing happens in chat.ts via Fix E — it routes Codex long
// tasks to the worker pool with a fresh context, NOT to a different
// provider. Auto-falling-back to Anthropic was the wrong call: it
// defeated the worker pool's whole purpose, surprised users with
// unexpected provider switches, and never validated that workers can
// make Codex perform on long tasks. Workers + fresh context IS the fix.

import { buildCleanHistory } from "../providers/sanitize.js";
import { processAttachments } from "./attachments.js";
import type { AgentRequestInput, ForcedToolChoice, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { noteResolvedAuthSource, noteResolvedModel } from "../cost-tracker.js";
import { providerUndercallsTools } from "../providers/provider-ids.js";
import { createLogger } from "../logger.js";

import { buildContext, isTrivialToolRequest } from "./prepare-request/build-context.js";
import { selectTools, type ToolSelectionResult } from "./prepare-request/tool-selection.js";
import { isSlashCommandExpansion } from "../slash-commands.js";
import { buildHistoryDigest } from "../classifiers/intent-classifier.js";
import { detectAndBoostCurate } from "./prepare-request/curate-nudge.js";
import { buildSystemPrompt } from "./prepare-request/build-system-prompt.js";

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

/**
 * Whether an intent verdict should PIN tool_choice (hard-force the tool) this
 * turn. Pure so the force/lean rule is one named chokepoint, testable without
 * the pipeline. Pins ONLY when the verdict is a non-free, non-self_edit kind AND
 * graded mode="force" (explicit + fully-specified ask). A "lean" verdict — right
 * kind, thin/one-line ask — deliberately does NOT pin: the tool stays loaded and
 * the audience is still narrowed, but the model is free to ask 1-3 clarifying
 * questions first. self_edit is never pinnable (destructive, needs explicit
 * same-turn permission), regardless of mode.
 */
export function shouldPinIntentToolChoice(
  verdict: { kind: string; mode: string } | null | undefined,
): boolean {
  return (
    !!verdict &&
    verdict.kind !== "free" &&
    verdict.kind !== "self_edit" &&
    verdict.mode === "force"
  );
}

// Rolling force/lean tally so the trigger-happy rate is visible in the log
// without grepping and hand-counting per-turn lines. Only NON-FREE verdicts
// count — those are the turns the fix is about (free turns never forced). The
// pinned share is the trigger-happiness metric: before the fix every non-free
// build/spawn turn pinned; after it, only fully-specified ones should. Process-
// lifetime, in-memory — a debugging lens, not persisted telemetry.
const intentTally = { forced: 0, leaned: 0 };

export function recordIntentOutcome(pinned: boolean): { forced: number; leaned: number; pinnedPct: number } {
  if (pinned) intentTally.forced++;
  else intentTally.leaned++;
  const total = intentTally.forced + intentTally.leaned;
  const pinnedPct = total === 0 ? 0 : Math.round((intentTally.forced / total) * 100);
  return { forced: intentTally.forced, leaned: intentTally.leaned, pinnedPct };
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

  // 2. Sanitize + truncate history. Compaction now lives as a leading
  // `system` message in sessionMessages itself (round-tripped through a
  // `summary` row in the per-session jsonl log on disk). No special-case
  // slice/prepend logic needed here — the session passed in is already
  // the right shape, with `[system_summary, ...recent_msgs]` when
  // compacted and just `[...msgs]` otherwise.
  end = stepStart("truncateHistory");
  const cleanHistory = buildCleanHistory(input.sessionMessages, input.channel, input.maxHistory);
  end();

  // 3. Tool selection (intent + tier filter + RAG re-rank). Must run
  // before build-context so we know the tier (weak-tier context strip)
  // and before system-prompt build so forceBuildIntent can drive the
  // CLI nudge.
  //
  // Lean callers (voice) override tools + prompt downstream, so the whole
  // selection — including the ~1.5-6s intent classifier — is wasted work on
  // their critical path. Skip it; just compute the tier (cheap, sync) which
  // build-context still needs for the weak-model strip.
  let toolSel: ToolSelectionResult;
  if (input.leanPrep) {
    const { classifyModel } = await import("../model-tiers.js");
    toolSel = {
      tools: [],
      tier: classifyModel(resolved.model) as ToolSelectionResult["tier"],
      intentVerdict: null,
      forceBuildIntent: false,
      isBridge: false,
    };
  } else {
    // A slash-command methodology (e.g. /app-build) runs across MANY turns, but
    // only its FIRST turn carries the marker. Without this, the intent classifier
    // re-fires on every later reply and can force build_app mid-methodology — the
    // "step 2 kicked off the build" regression. Treat the whole session as
    // methodology-active once ANY prior user turn was a slash-command expansion.
    const priorMethodology = cleanHistory.some(
      (m) => m.role === "user" && typeof m.content === "string" && isSlashCommandExpansion(m.content),
    );
    // Digest the PRIOR turns only (drop the final entry — it's this turn's
    // message, already classified directly). Gives the classifier the discussion
    // context that disambiguates "build" / "yes, build it".
    const priorTurns = cleanHistory.slice(0, -1) as ReadonlyArray<{ role: string; content: unknown }>;
    const historyDigest = buildHistoryDigest(priorTurns);
    end = stepStart("selectTools");
    toolSel = await selectTools({
      message: input.message,
      channel: input.channel,
      allAgentTools: input.allAgentTools,
      bridgeTools: input.bridgeTools,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.model,
      priorMethodology,
      historyDigest,
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
  // build-intent CLI nudge if applicable).
  end = stepStart("buildSystemPrompt");
  const systemPrompt = await buildSystemPrompt({
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
    forceBuildIntent: toolSel.forceBuildIntent,
    buildMode: toolSel.intentVerdict?.kind === "build_app" ? toolSel.intentVerdict.mode : undefined,
    intentReason: toolSel.intentVerdict?.reason,
  });
  end();

  // 7. Process attachments. Images become message image-blocks; non-image files
  // (PDF/doc/etc.) get a system-prompt note handing the model the readable
  // "/uploads/<f>" PATH. One tested unit (attachments.ts) owns this — it used to
  // be inline and silently dropped non-images, 404'ing every PDF/doc upload.
  const { images, fileAttachmentNote } = processAttachments(input.attachments, input.uploadsDir);

  // 8. Intent-classifier tool_choice forcing. Verdict was computed in
  // step 3 so it could drive tool-filter narrowing; here we reuse it to
  // pin tool_choice. Forces the LLM to emit a real tool_use block
  // instead of narrating its plan in prose ([Reading routes/] etc.).
  // HTTP-path providers consume this natively; CLI/OAuth ignores it
  // but the tool-filter strip-down already biased the model toward
  // the right choice.
  let toolChoice: ForcedToolChoice | undefined;
  // self_edit is deliberately NOT force-pinnable. It modifies LAX's own
  // source (destructive, propagates via git) and the system prompt already
  // requires explicit user permission in the same turn — so hard-forcing it
  // from a one-line intent guess contradicts its own invariant. The model
  // keeps self_edit in its toolset and can still pick it, but a classifier
  // false-positive (e.g. a workspace-app change misread as a LAX bug) no
  // longer locks the model out of edit/write. build_app/agent_spawn stay
  // forceable — they're reversible and models chronically under-call them.
  // Force/lean rule lives in shouldPinIntentToolChoice: a "lean" verdict narrows
  // + keeps the tool loaded (forceBuildIntent=kind, tool-selection.ts) but does
  // NOT pin, so the model can ask clarifying questions before executing.
  if (shouldPinIntentToolChoice(toolSel.intentVerdict)) {
    const forcedName = toolSel.intentVerdict!.kind;
    const inToolList = toolSel.tools.some(t => t.name === forcedName);
    if (inToolList) {
      toolChoice = { type: "tool", name: forcedName };
      const t = recordIntentOutcome(true);
      logger.info(`[intent] forcing ${forcedName} mode=force pinned=${t.forced}/${t.forced + t.leaned} (${t.pinnedPct}%) (reason="${toolSel.intentVerdict!.reason}")`);
    } else {
      logger.warn(`[intent] classifier picked ${forcedName} but it's not in this turn's tool list — skipping force`);
    }
  } else if (toolSel.intentVerdict && toolSel.intentVerdict.kind !== "free") {
    const t = recordIntentOutcome(false);
    logger.info(`[intent] ${toolSel.intentVerdict.kind} mode=lean — narrowing without pin, pinned=${t.forced}/${t.forced + t.leaned} (${t.pinnedPct}%) (reason="${toolSel.intentVerdict.reason}")`);
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
    codexApiKey: resolved.codexApiKey,
    customBaseURL: resolved.customBaseURL,
    systemPrompt: systemPrompt + fileAttachmentNote,
    tools: toolSel.tools,
    cleanHistory,
    images,
    temperature: resolved.temperature,
    maxIterations: resolved.maxIterations,
    authSource: resolved.authSource,
    toolChoice,
  };
}
