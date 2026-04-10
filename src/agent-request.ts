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

  // Resolve provider
  let provider = String(saved.provider || "");
  if (!["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"].includes(provider)) {
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
    (provider === "codex" ? "gpt-5.3-codex" :
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

  const shouldRunMemory = !skipMemory && !isTrivialToolRequest;

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
    // Bridge/cron — lightweight context only
    try {
      [contextBlock, relevantMemories] = await Promise.all([
        buildContextBlock(memoryIndex),
        autoSearchContext(memoryIndex, message),
      ]);
    } catch {}
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
  try {
    const { buildToolPromptSection } = await import("./tool-prompt-builder.js");
    toolPromptSection = buildToolPromptSection(allAgentTools);
  } catch {}

  let systemPrompt: string;
  if (systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = systemPromptOverride;
  } else {
    const { createChatContextBuilder } = await import("./context-builder.js");
    const contextBuilder = createChatContextBuilder({
      systemPrompt: config.systemPrompt,
      providerHint,
      toolPromptSection,
      contextBlock,
      relevantMemories,
      smartContext,
      memoryContext,
      notificationHint,
      integrationsContext,
      canaryBlock: "", // Canary injection handled by caller (needs ThreatEngine instance)
    });
    systemPrompt = await contextBuilder.build();
  }

  // 5. Select tools based on provider + channel
  const isCodex = resolved.provider === "codex";
  const isBridge = channel === "telegram" || channel === "whatsapp";
  const tools = (isCodex || isBridge) ? bridgeTools : allAgentTools;

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
