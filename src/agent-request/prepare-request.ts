import { join } from "node:path";
import type { ChatCompletionMessageParam as ChatCompletionMessageParamLike } from "openai/resources/chat/completions.js";
import { sanitizeHistory, truncateHistory } from "../agent-providers.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { AgentRequestInput, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { CORE_TOOL_NAMES, filterToolsForMessage } from "./tool-filter.js";

import { createLogger } from "../logger.js";
const logger = createLogger("agent-request.prepare-request");

export async function prepareAgentRequest(input: AgentRequestInput): Promise<PreparedAgentRequest> {
  const {
    channel, message, sessionMessages, sessionId, config, dataDir,
    memoryIndex, memoryManager, integrations, secretsStore, allAgentTools, bridgeTools,
    skipMemory, systemPromptOverride, attachments, uploadsDir,
  } = input;

  // 1. Resolve provider + keys
  // (Long-task routing happens in chat.ts via Fix E — it routes Codex long
  // tasks to the worker pool with a fresh context, NOT to a different
  // provider. Auto-falling-back to Anthropic was the wrong call: it
  // defeated the worker pool's whole purpose, surprised users with
  // unexpected provider switches, and never validated that workers can
  // make Codex perform on long tasks. Workers + fresh context IS the fix.)
  const resolved = await resolveProvider(config, secretsStore, dataDir);
  void logger; // logger kept for future routing diagnostics

  // 2. Sanitize + truncate history. If the session has a stored compaction
  // summary from /api/compact, slice the message list to the post-compaction
  // tail and prepend the summary as a system message — preserves long-session
  // grounding without re-summarizing every turn.
  const maxKeep = input.maxHistory || (channel === "web" ? 40 : 30);
  let historyForPrep: ChatCompletionMessageParamLike[] = sessionMessages;
  if (
    input.compactedSummary &&
    typeof input.compactedAt === "number" &&
    input.compactedAt > 0 &&
    input.compactedAt < sessionMessages.length
  ) {
    // Defensive floor: even if compaction was triggered very close to the
    // end, always keep the last KEEP_RECENT_MIN messages verbatim. Without
    // this floor, a "yes" / "1" / "3" reply to a numbered list could land
    // after the cut and the agent would have no way to interpret the short
    // answer — the prior assistant turn would only exist as a one-line
    // summary entry. Bug observed in Apr 2026 session: user replied "3" to
    // a numbered list and the agent answered "I don't have a numbered list
    // in front of you" because the list got swallowed by compaction.
    const KEEP_RECENT_MIN = 6;
    const minTailStart = Math.max(0, sessionMessages.length - KEEP_RECENT_MIN);
    const tailStart = Math.min(input.compactedAt, minTailStart);
    const tail = sessionMessages.slice(tailStart);
    historyForPrep = [
      { role: "system", content: input.compactedSummary } as ChatCompletionMessageParamLike,
      ...tail,
    ];
    logger.info(`[compaction] reusing stored summary (compactedAt=${input.compactedAt}, tailStart=${tailStart}, summaryLen=${input.compactedSummary.length}, tail=${tail.length})`);
  }
  const cleanHistory = truncateHistory(sanitizeHistory(historyForPrep), maxKeep);

  // 3. Build context (skip heavy parts for bridges/cron). The memory pipeline
  // runs for every provider — the orchestrator's grounding signals help Codex
  // the same way they help Claude. Daily log stays skipped for Codex to keep
  // OpenAI content-moderation from tripping on replayed verbatim user messages.
  const isTrivialToolRequest = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
    /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
  const isCodexProvider = resolved.provider === "codex";
  const turnCtx = await memoryManager.buildTurnContext({
    userMessage: message,
    sessionId,
    sessionMessages: sessionMessages.slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    })),
    skipDailyLog: isCodexProvider,
    liteMode: !skipMemory && isTrivialToolRequest,
    minimalMode: skipMemory,
  });
  let contextBlock = turnCtx.contextBlock;
  const relevantMemories = turnCtx.relevantMemories;
  const smartContext = turnCtx.smartContext;
  const memoryContext = turnCtx.memoryContext;
  const memoryNotifications = turnCtx.notifications;
  if (isTrivialToolRequest && !skipMemory) logger.info(`[chat] Trivial tool request — skipping memory injection`);
  else if (isCodexProvider && !skipMemory) logger.info(`[chat] Codex provider — daily log skipped`);

  // For Codex (128k context), cap the memory context block. The full
  // core_memory dump can be 5,000+ tokens of retained facts — essential
  // for 200k+ models but overkill for casual chat on a tight budget.
  // Keep identity + profile + today context, trim core_memory to first 2k chars.
  if (isCodexProvider && contextBlock.length > 3000) {
    contextBlock = contextBlock.replace(
      /<core_memory>([\s\S]*?)<\/core_memory>/,
      (_, content: string) => `<core_memory>\n${content.slice(0, 2000)}\n[...truncated for context budget]\n</core_memory>`
    );
  }

  // 4. Build system prompt
  const providerNames: Record<string, string> = {
    codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok",
    openai: "OpenAI", local: "Local (Ollama)", gemini: "Google Gemini",
  };
  const providerHint = `\n\n[System: You are currently powered by ${providerNames[resolved.provider] || resolved.provider}, model: ${resolved.model}.]`;
  const integrationsContext = integrations.getAgentContext();

  let notificationHint = "";
  if (memoryNotifications.length > 0) {
    const topNotifs = memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
    notificationHint = "\n\n[Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | ") + "]";
  }

  let toolPromptSection = "";
  // Tool prompt section adds per-tool usage guidance — skip for Codex to save tokens
  if (!isCodexProvider) {
    try {
      const { buildToolPromptSection } = await import("../tool-prompt-builder.js");
      toolPromptSection = buildToolPromptSection(allAgentTools);
    } catch {}
  }

  let systemPrompt: string;
  if (systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = systemPromptOverride;
  } else {
    // Use full prompt for all providers. The empty-response issue was caused
    // by reasoning: { effort: "low" } in codex-client.ts, not prompt size.
    // The full prompt contains behavioral instructions the agent needs.
    // Prefer hot-reloadable config file over static config object
    const basePrompt = loadSystemPrompt() || config.systemPrompt;

    const { createSystemPromptBuilder } = await import("../context-builder.js");
    const contextBuilder = createSystemPromptBuilder({
      basePrompt,
      providerHint,
      toolPromptSection,
      integrationsContext,
      contextBlock,
      relevantMemories,
      smartContext,
      memoryContext,
      notificationHint,
      bridgeContext: input.bridgeContext,
    });
    systemPrompt = await contextBuilder.build();
  }

  // 5. Select tools based on channel (bridges get a smaller set)
  //    For web/codex: filter to core + message-relevant tools to reduce schema overhead.
  //    tool_search is always included so the agent can discover anything else.
  //
  //    Pipeline: keyword filter first (fast, always works) → semantic rerank
  //    via Tool RAG if an embedder is available (more accurate for phrasing
  //    the keyword regex misses). Falls back to keyword-only result on failure.
  const isBridge = channel === "telegram" || channel === "whatsapp";
  let tools = isBridge ? bridgeTools : filterToolsForMessage(allAgentTools, message);

  // Shrink for weaker models. 100+ tool catalogs paralyze Grok / small local
  // models (0-token responses). Cap aggressively while keeping essentials
  // ordered first. Strong models (GPT-5, Opus 4.7, o3, Gemini 2.5) pass through.
  // Pass allAgentTools as a source for essentials so we can guarantee
  // read/write/bash/http_request/etc. are present even if the prefilter
  // dropped them.
  const { classifyModel, shrinkToolsForTier } = await import("../model-tiers.js");
  const tier = classifyModel(resolved.model);
  if (tier !== "strong") {
    const before = tools.length;
    tools = shrinkToolsForTier(tools, tier, allAgentTools);
    if (tools.length !== before) {
      logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${resolved.model} (${tools.map(t=>t.name).join(",")})`);
    }
  }
  if (!isBridge) {
    try {
      const { getToolRAG } = await import("../tool-rag.js");
      const rag = getToolRAG();
      // Use the memory embedder if available (already configured at startup)
      const embedder = (memoryIndex as unknown as { embeddingProvider?: { embed(t: string): Promise<number[]> } }).embeddingProvider;
      if (embedder && rag.size === 0) {
        rag.setEmbedder(embedder);
        await rag.build(allAgentTools);
      }
      if (rag.isReady) {
        // Semantic select across ALL tools (broader than keyword). Pin the core
        // set so always-available tools never get filtered out, even if the
        // user's message doesn't semantically mention them.
        const semantic = await rag.select(message, allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: [...CORE_TOOL_NAMES],
          includeMCP: true,
        });
        // Union with keyword result — never narrower than keyword-only
        const union = new Set(tools.map(t => t.name));
        for (const t of semantic) union.add(t.name);
        tools = allAgentTools.filter(t => union.has(t.name));
      }
    } catch (e) {
      // Fail open: use keyword result unchanged
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
  }

  // 6. Process image attachments
  const images: Array<{ url: string; filePath?: string; name: string }> = [];
  if (attachments && uploadsDir) {
    for (const a of attachments) {
      if (a.isImage && a.url) {
        const fname = a.url.replace(/^\/uploads\//, "");
        images.push({ name: a.name, url: a.url, filePath: join(uploadsDir, fname) });
      }
    }
  }

  return {
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    model: resolved.model,
    codexApiKey: resolved.codexApiKey,
    customBaseURL: resolved.customBaseURL,
    systemPrompt,
    tools,
    cleanHistory,
    images,
    temperature: resolved.temperature,
    maxIterations: resolved.maxIterations,
  };
}
