import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildContextBlock, autoSearchContext } from "../memory.js";
import { sanitizeHistory, truncateHistory } from "../agent-providers.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { AgentRequestInput, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { CORE_TOOL_NAMES, filterToolsForMessage } from "./tool-filter.js";

export async function prepareAgentRequest(input: AgentRequestInput): Promise<PreparedAgentRequest> {
  const {
    channel, message, sessionMessages, sessionId, config, dataDir,
    memoryIndex, integrations, secretsStore, allAgentTools, bridgeTools,
    skipMemory, systemPromptOverride, attachments, uploadsDir,
  } = input;

  // 1. Resolve provider + keys
  const resolved = await resolveProvider(config, secretsStore, dataDir);

  // 2. Sanitize + truncate history
  const maxKeep = input.maxHistory || (channel === "web" ? 40 : 30);
  const cleanHistory = truncateHistory(sanitizeHistory(sessionMessages), maxKeep);

  // 3. Build context (skip heavy parts for bridges/cron)
  let contextBlock = "";
  let relevantMemories = "";
  let smartContext = "";
  let memoryContext = "";
  let memoryNotifications: Array<{ type: string; message: string; priority: number }> = [];

  const isTrivialToolRequest = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
    /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());

  // Memory pipeline runs for every provider now. The earlier Codex-exclusion
  // was a conservative guess when we thought extra context was causing bias —
  // turned out the real bias was in the tool-keyword map (agent-request.ts
  // was coupling "app" to sidebar tool surfacing). With that fixed, the
  // orchestrator's grounding signals (anticipatory care, growth tracker,
  // semantic search over memory facts, session summaries) help Codex stay
  // on task the same way they help Claude. Extra ~2-6k tokens per iteration
  // is a fair trade for better grounding; per-turn token ceiling still
  // protects against runaway.
  //
  // Daily log stays skipped for Codex to protect against OpenAI's content
  // moderation tripping on replayed verbatim user messages.
  const isCodexProvider = resolved.provider === "codex";
  const shouldRunMemory = !skipMemory && !isTrivialToolRequest;

  if (shouldRunMemory) {
    [contextBlock, relevantMemories] = await Promise.all([
      buildContextBlock(memoryIndex, { userMessage: message, skipDailyLog: isCodexProvider }),
      autoSearchContext(memoryIndex, message),
    ]);

    // Smart context from session summaries
    try {
      const summaryDir = join(dataDir, "memory", "session-summaries");
      if (existsSync(summaryDir)) {
        const summaryFiles = readdirSync(summaryDir).filter(f => f.endsWith(".md"));
        const queryWords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (queryWords.length > 0 && summaryFiles.length > 0) {
          const scored = summaryFiles.map(f => {
            const content = readFileSync(join(summaryDir, f), "utf-8");
            const lower = content.toLowerCase();
            let score = 0;
            for (const w of queryWords) { if (lower.includes(w)) score++; }
            return { content: content.slice(0, 400), score };
          }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
          if (scored.length > 0) {
            smartContext = "\n\n--- RELATED PAST SESSIONS ---\n" + scored.map(s => s.content).join("\n---\n") + "\n--- END ---";
          }
        }
      }
    } catch {}

    // Memory orchestrator
    try {
      const { processMessage } = await import("../memory-orchestrator.js");
      const orch = await processMessage({
        message,
        sessionId,
        sessionMessages: sessionMessages.slice(-20).map(m => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
        })),
        timeOfDay: new Date().getHours(),
        dayOfWeek: new Date().getDay(),
        agentPreviousMessage: sessionMessages.filter(m => m.role === "assistant").pop()?.content as string || undefined,
      });
      memoryContext = orch.contextInjection ? `\n\n${orch.contextInjection}` : "";
      memoryNotifications = orch.notifications || [];
      if (orch.debug) console.log(`[memory] Orchestrator: ${orch.debug.modulesActivated.length} modules, ${orch.debug.totalTimeMs}ms`);
    } catch (e) {
      console.warn("[memory] Orchestrator error:", (e as Error).message);
    }
  } else if (!skipMemory) {
    // Trivial tool request OR Codex — basic context block only. Daily log
    // stays skipped for Codex to keep OpenAI content-moderation from
    // tripping on replayed verbatim user messages.
    try {
      [contextBlock] = await Promise.all([
        buildContextBlock(memoryIndex, { skipDailyLog: isCodexProvider, userMessage: message }),
      ]);
    } catch {}
    if (isTrivialToolRequest) console.log(`[chat] Trivial tool request — skipping memory injection`);
    else if (isCodexProvider) console.log(`[chat] Codex provider — lean context (no orchestrator, no semantic search, no daily log)`);
  } else {
    // Bridge/cron/Codex — lightweight context only (skip autoSearch to save tokens)
    try {
      contextBlock = await buildContextBlock(memoryIndex);
    } catch {}
  }

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
      console.log(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${resolved.model} (${tools.map(t=>t.name).join(",")})`);
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
      console.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
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
