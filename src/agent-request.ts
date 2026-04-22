/**
 * Unified agent request preparation.
 *
 * ALL entry points (web chat, bridge, cron, sub-agents) call this to build
 * a fully-prepared request before calling runAgent(). This eliminates the
 * duplicated provider resolution, session sanitization, context building,
 * and prompt assembly that previously lived inline in 4 separate handlers.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition, SAXConfig, Session } from "./types.js";
import type { MemoryIndex } from "./memory.js";
import type { IntegrationRegistry } from "./integrations.js";
import type { SecretsStore } from "./secrets.js";
import { buildContextBlock, autoSearchContext } from "./memory.js";
import { sanitizeHistory, truncateHistory } from "./agent-providers.js";
import { getApiKey } from "./auth.js";
import { loadSystemPrompt } from "./config-loader.js";

// ── Types ──

export type ChannelKind = "web" | "telegram" | "whatsapp" | "cron" | "agent";

export interface AgentRequestInput {
  /** Which entry point is calling */
  channel: ChannelKind;
  /** The user's message */
  message: string;
  /** Session messages (raw, will be sanitized) */
  sessionMessages: ChatCompletionMessageParam[];
  /** Session ID for the agent run */
  sessionId: string;
  /** App config */
  config: SAXConfig;
  /** Data directory (~/.sax) */
  dataDir: string;
  /** Memory index for context building */
  memoryIndex: MemoryIndex;
  /** Integration registry for API context */
  integrations: IntegrationRegistry;
  /** Secrets store for API key lookups */
  secretsStore: SecretsStore;
  /** Full tool set (web chat) */
  allAgentTools: ToolDefinition[];
  /** Slimmed tool set (bridges, Codex) */
  bridgeTools: ToolDefinition[];
  /** Skip heavy memory orchestrator (bridges, cron) */
  skipMemory?: boolean;
  /** Override system prompt (sub-agents) */
  systemPromptOverride?: string;
  /** Max messages to keep in history (default 30 for bridges, 40 for web) */
  maxHistory?: number;
  /** Bridge-specific context string (platform, channel, formatting rules) */
  bridgeContext?: string;
  /** Image attachments */
  attachments?: Array<{ isImage: boolean; url: string; name: string }>;
  /** Uploads directory for resolving attachment paths */
  uploadsDir?: string;
}

export interface PreparedAgentRequest {
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  cleanHistory: ChatCompletionMessageParam[];
  images: Array<{ url: string; filePath?: string; name: string }>;
  temperature: number;
  maxIterations: number;
}

// ── Provider resolution (shared by all paths) ──

export async function resolveProvider(
  config: SAXConfig,
  secretsStore: SecretsStore,
  dataDir: string,
): Promise<{
  provider: string;
  apiKey: string;
  model: string;
  codexApiKey?: string;
  customBaseURL?: string;
  temperature: number;
  maxIterations: number;
}> {
  const { loadTokens } = await import("./auth.js");
  const { loadAnthropicTokens, getAnthropicApiKey } = await import("./auth-anthropic.js");

  // Load saved settings
  let saved: Record<string, unknown> = {};
  try {
    const sp = join(dataDir, "settings.json");
    if (existsSync(sp)) saved = JSON.parse(readFileSync(sp, "utf-8"));
  } catch {}

  // Resolve provider. If a saved provider exists but has no usable credentials,
  // fall through to auto-detection so a stale "codex" default from a previous
  // run doesn't block a freshly-signed-in Anthropic user.
  const VALID = ["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"];
  const hasCredsFor = (p: string): boolean => {
    if (p === "anthropic") return !!loadAnthropicTokens();
    if (p === "codex") return !!loadTokens();
    if (p === "openai") return !!(config.openaiApiKey || secretsStore.get("OPENAI_API_KEY"));
    if (p === "xai") return !!secretsStore.get("XAI_API_KEY");
    if (p === "gemini") return !!secretsStore.get("GEMINI_API_KEY");
    if (p === "custom") return !!secretsStore.get("CUSTOM_API_KEY");
    if (p === "local") return true;
    return false;
  };
  let provider = String(saved.provider || "");
  if (!VALID.includes(provider) || !hasCredsFor(provider)) {
    provider = loadAnthropicTokens() ? "anthropic" : (loadTokens() && !config.openaiApiKey) ? "codex" : "xai";
  }

  // Resolve API key
  let apiKey: string;
  let codexApiKey: string | undefined;
  let customBaseURL: string | undefined;

  if (provider === "local") {
    apiKey = "ollama";
  } else if (provider === "anthropic") {
    apiKey = await getAnthropicApiKey();
    try { codexApiKey = await getApiKey(config.openaiApiKey); } catch {}
    if (!codexApiKey) codexApiKey = secretsStore.get("OPENAI_API_KEY") || undefined;
  } else if (provider === "xai") {
    apiKey = secretsStore.get("XAI_API_KEY") || "";
  } else if (provider === "gemini") {
    apiKey = secretsStore.get("GEMINI_API_KEY") || "";
  } else if (provider === "custom") {
    apiKey = secretsStore.get("CUSTOM_API_KEY") || "";
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) {
        const ss = JSON.parse(readFileSync(sp, "utf-8"));
        customBaseURL = ss.customBaseUrl || undefined;
      }
    } catch {}
  } else if (provider === "openai" && !config.openaiApiKey) {
    apiKey = secretsStore.get("OPENAI_API_KEY") || await getApiKey(config.openaiApiKey);
  } else {
    apiKey = await getApiKey(config.openaiApiKey);
  }

  const model = String(saved.model || "") ||
    (provider === "codex" ? "gpt-5.4-mini" :
     provider === "anthropic" ? "claude-sonnet-4-6" :
     provider === "gemini" ? "gemini-2.0-flash" :
     config.model);

  const temperature = typeof saved.temperature === "number" ? saved.temperature : config.temperature;
  const maxIterations = typeof saved.maxIterations === "number" ? saved.maxIterations : config.maxIterations;

  return { provider, apiKey, model, codexApiKey, customBaseURL, temperature, maxIterations };
}

// ── Main preparation function ──

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

  // Skip heavy memory orchestrator for Codex (128k context). The orchestrator's
  // 7+ modules (emotional memory, growth tracker, anticipatory care, etc.) add
  // rich context that's great for 200k+ models but pushes Codex past the point
  // where it returns empty responses. Basic context (identity, profile) still runs.
  const isCodexProvider = resolved.provider === "codex";
  const shouldRunMemory = !skipMemory && !isTrivialToolRequest && !isCodexProvider;

  if (shouldRunMemory) {
    [contextBlock, relevantMemories] = await Promise.all([
      buildContextBlock(memoryIndex),
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
      const { processMessage } = await import("./memory-orchestrator.js");
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
    // Trivial tool request — still get basic context but skip orchestrator
    try { [contextBlock] = await Promise.all([buildContextBlock(memoryIndex)]); } catch {}
    if (isTrivialToolRequest) console.log(`[chat] Trivial tool request — skipping memory injection`);
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
      const { buildToolPromptSection } = await import("./tool-prompt-builder.js");
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

    const { createSystemPromptBuilder } = await import("./context-builder.js");
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
  const { classifyModel, shrinkToolsForTier } = await import("./model-tiers.js");
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
      const { getToolRAG } = await import("./tool-rag.js");
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

// ── Smart Tool Filtering ──
// Always include core tools. Add extras if the user's message hints at them.
// tool_search is always included so the agent can discover anything else.

const CORE_TOOL_NAMES = new Set([
  // Filesystem & code
  "read", "write", "edit", "bash", "glob", "grep",
  // Web & search
  "web_fetch", "web_search",
  // Interaction
  "ask_user", "tool_search",
  // Vision
  "view_image", "screen_capture",
  // Memory
  "memory_search", "memory_save", "memory_recall", "memory_get",
  "memory_forget", "memory_reflect", "memory_update_profile", "memory_stats",
  "memory_consolidate", "memory_ingest",
  // Operations — long-horizon goal orchestration
  "operation_start", "operation_list", "operation_status", "operation_next", "operation_advance",
  // Planning & tasks
  "enter_plan_mode", "exit_plan_mode",
  "task_create", "task_update", "task_list", "task_get",
  // Protocols & scheduling
  "protocol_list", "protocol_get",
  "mission_schedule_create", "mission_schedule_list", "mission_schedule_update",
  "mission_schedule_delete", "mission_schedule_toggle",
  // Agents
  "agent_spawn", "delegate", "agent_status", "agent_cancel", "agent_message", "agent_output",
  // Browser
  "browser",
  // Apps
  "build_app", "app_create", "app_list",
  // Secrets
  "request_secret", "list_secrets",
  // HTTP
  "http_request",
]);

// Keywords that trigger including specific tool groups
const TOOL_KEYWORD_MAP: Array<{ keywords: RegExp; toolPrefixes: string[] }> = [
  { keywords: /spreadsheet|excel|xlsx|csv|sheet/i, toolPrefixes: ["spreadsheet_"] },
  { keywords: /document|docx|word/i, toolPrefixes: ["document_"] },
  { keywords: /presentation|slide|pptx|powerpoint/i, toolPrefixes: ["presentation_"] },
  { keywords: /pdf/i, toolPrefixes: ["pdf_"] },
  { keywords: /email|mail|inbox|send.*email/i, toolPrefixes: ["email_"] },
  { keywords: /calendar|event|meeting|schedule.*event/i, toolPrefixes: ["calendar_"] },
  { keywords: /clipboard|copy|paste/i, toolPrefixes: ["clipboard_"] },
  { keywords: /sql|database|query.*table|postgres|sqlite/i, toolPrefixes: ["sql_"] },
  { keywords: /image|photo|generate.*image|draw|picture/i, toolPrefixes: ["generate_image", "generate_video", "ocr"] },
  { keywords: /camera|webcam/i, toolPrefixes: ["camera_"] },
  { keywords: /app|dashboard|tracker/i, toolPrefixes: ["app_"] },
  { keywords: /issue|ticket|project|kanban/i, toolPrefixes: ["issue_"] },
  { keywords: /instagram|twitter|tiktok|social|post on/i, toolPrefixes: ["mission_"] },
  { keywords: /config|setting/i, toolPrefixes: ["config_"] },
  { keywords: /skill/i, toolPrefixes: ["skill_"] },
  { keywords: /rollback|undo.*mission/i, toolPrefixes: ["mission_rollback_"] },
  { keywords: /chain|pipeline/i, toolPrefixes: ["mission_chain_"] },
  { keywords: /template/i, toolPrefixes: ["mission_template"] },
  { keywords: /marketplace/i, toolPrefixes: ["marketplace_"] },
  { keywords: /agency|team|hire/i, toolPrefixes: ["agency_"] },
];

// Build intent = minimal tool set. When the user asks to build/create an app,
// the agent only needs file operations. Fewer tools = smaller context = Codex
// stops returning empty responses on complex prompts.
const BUILD_INTENT_TOOLS = new Set([
  // build_app is the primary tool for new apps — spawns CLI subprocess for reliability
  "build_app",
  // Direct file tools for edits and simple tasks
  "write", "edit", "read", "bash", "glob", "grep",
  "web_fetch", "web_search", "tool_search",
  "ask_user", "view_image",
]);
const BUILD_INTENT_REGEX = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script)/i;

function filterToolsForMessage(allTools: ToolDefinition[], message: string): ToolDefinition[] {
  // Build intent: ultra-minimal tool set (~11 tools vs 40+)
  // This is critical for Codex which returns empty responses when context is bloated
  if (BUILD_INTENT_REGEX.test(message)) {
    return allTools.filter(t => BUILD_INTENT_TOOLS.has(t.name));
  }

  const included = new Set<string>();

  // Always include core tools
  for (const name of CORE_TOOL_NAMES) included.add(name);

  // Add tools matching user message keywords
  for (const { keywords, toolPrefixes } of TOOL_KEYWORD_MAP) {
    if (keywords.test(message)) {
      for (const tool of allTools) {
        for (const prefix of toolPrefixes) {
          if (tool.name.startsWith(prefix) || tool.name === prefix) {
            included.add(tool.name);
          }
        }
      }
    }
  }

  return allTools.filter(t => included.has(t.name));
}
