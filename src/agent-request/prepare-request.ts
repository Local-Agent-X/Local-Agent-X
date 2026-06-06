// Per-turn agent-request preparation pipeline. Thin orchestrator — each
// numbered step delegates to a focused module under ./prepare-request/*.
//
// Long-task routing happens in chat.ts via Fix E — it routes Codex long
// tasks to the worker pool with a fresh context, NOT to a different
// provider. Auto-falling-back to Anthropic was the wrong call: it
// defeated the worker pool's whole purpose, surprised users with
// unexpected provider switches, and never validated that workers can
// make Codex perform on long tasks. Workers + fresh context IS the fix.

import { join } from "node:path";
import { sanitizeHistory, truncateHistory } from "../providers/sanitize.js";
import type { AgentRequestInput, ForcedToolChoice, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { createLogger } from "../logger.js";

import { buildContext, isTrivialToolRequest } from "./prepare-request/build-context.js";
import { selectTools, type ToolSelectionResult } from "./prepare-request/tool-selection.js";
import { detectAndBoostCurate } from "./prepare-request/curate-nudge.js";
import { buildSystemPrompt } from "./prepare-request/build-system-prompt.js";

const logger = createLogger("agent-request.prepare-request");

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

  // 2. Sanitize + truncate history. Compaction now lives as a leading
  // `system` message in sessionMessages itself (round-tripped through a
  // `summary` row in the per-session jsonl log on disk). No special-case
  // slice/prepend logic needed here — the session passed in is already
  // the right shape, with `[system_summary, ...recent_msgs]` when
  // compacted and just `[...msgs]` otherwise.
  end = stepStart("truncateHistory");
  const maxKeep = input.maxHistory || (input.channel === "web" ? 40 : 30);
  const cleanHistory = truncateHistory(sanitizeHistory(input.sessionMessages), maxKeep);
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
    end = stepStart("selectTools");
    toolSel = await selectTools({
      message: input.message,
      channel: input.channel,
      allAgentTools: input.allAgentTools,
      bridgeTools: input.bridgeTools,
      resolvedProvider: resolved.provider,
      resolvedModel: resolved.model,
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
    intentReason: toolSel.intentVerdict?.reason,
  });
  end();

  // 7. Process image attachments
  const images: Array<{ url: string; filePath?: string; name: string }> = [];
  if (input.attachments && input.uploadsDir) {
    for (const a of input.attachments) {
      if (a.isImage && a.url) {
        const fname = a.url.replace(/^\/uploads\//, "");
        images.push({ name: a.name, url: a.url, filePath: join(input.uploadsDir, fname) });
      }
    }
  }

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
  if (
    toolSel.intentVerdict &&
    toolSel.intentVerdict.kind !== "free" &&
    toolSel.intentVerdict.kind !== "self_edit"
  ) {
    const forcedName = toolSel.intentVerdict.kind;
    const inToolList = toolSel.tools.some(t => t.name === forcedName);
    if (inToolList) {
      toolChoice = { type: "tool", name: forcedName };
      logger.info(`[intent] forcing ${forcedName} (reason="${toolSel.intentVerdict.reason}")`);
    } else {
      logger.warn(`[intent] classifier picked ${forcedName} but it's not in this turn's tool list — skipping force`);
    }
  }

  return {
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    model: resolved.model,
    codexApiKey: resolved.codexApiKey,
    customBaseURL: resolved.customBaseURL,
    systemPrompt,
    tools: toolSel.tools,
    cleanHistory,
    images,
    temperature: resolved.temperature,
    maxIterations: resolved.maxIterations,
    toolChoice,
  };
}
