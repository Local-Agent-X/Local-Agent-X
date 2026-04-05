import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { isValidSessionId, readBody, safeErrorMessage, sseWrite, corsHeaders, jsonResponse, BANNED_KEYS, safeParseBody } from "../server-utils.js";
import { runAgent } from "../agent.js";
import { detectInjection } from "../sanitize.js";
import { ChatRequestSchema, CompactSchema, validateBody } from "../route-schemas.js";
import { ThreatEngine } from "../threat-engine.js";
import { enqueue } from "../execution-lanes.js";
import { buildContextBlock, autoSearchContext, autoExtractAndSave } from "../memory.js";
import { formatForChannel, getChannelConfig } from "../channel-formatter.js";
import { resolveSession, buildChannelContext, type ChannelType } from "../session-router.js";
import { getApiKey } from "../auth.js";

export const handleChatRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Context compaction
  if (method === "POST" && url.pathname === "/api/compact") {
    const raw = await safeParseBody(req);
    const parsed = validateBody(raw, CompactSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    const sessionId = parsed.data.sessionId!;
    const session = ctx.getOrCreateSession(sessionId);
    if (session.messages.length < 10) { json(200, { ok: false, reason: `Only ${session.messages.length} messages (need 10+)` }); return true; }
    const KEEP_RECENT = Math.min(20, session.messages.length - 5);
    let cutIdx = Math.max(0, session.messages.length - KEEP_RECENT);
    for (let i = cutIdx; i < session.messages.length; i++) { if (session.messages[i].role === "user") { cutIdx = i; break; } }
    const oldMessages = session.messages.slice(0, cutIdx);
    const recentMessages = session.messages.slice(cutIdx);
    const summaryLines: string[] = [];
    for (const m of oldMessages) {
      if (m.role === "user" && typeof m.content === "string") summaryLines.push(`[User] ${m.content.slice(0, 200).replace(/\n/g, " ")}`);
      else if (m.role === "assistant" && typeof m.content === "string") summaryLines.push(`[Agent] ${m.content.split("\n").filter(l => l.trim()).slice(0, 2).join(" ").slice(0, 200)}`);
    }
    const compactSummary = `[COMPACTED CONTEXT — ${oldMessages.length} messages summarized]\n${summaryLines.join("\n")}\n[END COMPACTED CONTEXT — ${recentMessages.length} recent messages follow]`;
    session.compactedSummary = compactSummary;
    session.compactedAt = oldMessages.length;
    ctx.sessionStore.save(session);
    json(200, { ok: true, compactedAt: oldMessages.length, oldCount: oldMessages.length, recentCount: recentMessages.length });
    return true;
  }

  // Main chat SSE endpoint
  if (method === "POST" && url.pathname === "/api/chat") {
    const raw = await safeParseBody(req);
    if (!raw) { json(400, { error: "Invalid JSON body" }); return true; }
    const parsed = validateBody(raw, ChatRequestSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    const { message, attachments: _attachments } = parsed.data;
    const sessionId = parsed.data.sessionId!;
    const attachments = _attachments!;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(req) });

    const session = ctx.getOrCreateSession(sessionId);
    if (session.messages.length === 0) session.title = message.slice(0, 60) + (message.length > 60 ? "..." : "");

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const { loadTokens } = await import("../auth.js");
      const { loadAnthropicTokens, getAnthropicApiKey } = await import("../auth-anthropic.js");
      let savedProvider: string | null = null, savedModel: string | null = null, savedTemperature: number | null = null, savedMaxIterations: number | null = null;
      try {
        const sp = join(ctx.dataDir, "settings.json");
        if (existsSync(sp)) { const s = JSON.parse(readFileSync(sp, "utf-8")); savedProvider = s.provider || null; savedModel = s.model || null; if (typeof s.temperature === "number") savedTemperature = s.temperature; if (typeof s.maxIterations === "number") savedMaxIterations = s.maxIterations; }
      } catch {}

      let provider: "codex" | "xai" | "openai" | "anthropic" | "local" | "gemini" | "custom";
      if (savedProvider && ["codex", "xai", "openai", "anthropic", "local", "gemini", "custom"].includes(savedProvider)) provider = savedProvider as typeof provider;
      else if (loadAnthropicTokens()) provider = "anthropic";
      else if (loadTokens() && !ctx.config.openaiApiKey) provider = "codex";
      else provider = "xai";

      let apiKey: string;
      let customBaseURL: string | undefined;
      if (provider === "local") apiKey = "ollama";
      else if (provider === "anthropic") apiKey = await getAnthropicApiKey();
      else if (provider === "xai") { apiKey = ctx.secretsStore.get("XAI_API_KEY") || ""; if (!apiKey) { sseWrite(res, { type: "error", message: "No xAI API key configured." }); res.end(); return true; } }
      else if (provider === "gemini") { apiKey = ctx.secretsStore.get("GEMINI_API_KEY") || ""; if (!apiKey) { sseWrite(res, { type: "error", message: "No Google API key configured." }); res.end(); return true; } }
      else if (provider === "custom") { apiKey = ctx.secretsStore.get("CUSTOM_API_KEY") || ""; if (!apiKey) { sseWrite(res, { type: "error", message: "No API key for custom provider." }); res.end(); return true; } try { const sp = join(ctx.dataDir, "settings.json"); if (existsSync(sp)) { const ss = JSON.parse(readFileSync(sp, "utf-8")); customBaseURL = ss.customBaseUrl || undefined; } } catch {} }
      else if (provider === "openai" && !ctx.config.openaiApiKey) apiKey = ctx.secretsStore.get("OPENAI_API_KEY") || await getApiKey(ctx.config.openaiApiKey);
      else apiKey = await getApiKey(ctx.config.openaiApiKey);

      const wsChat = ctx.chatWs.startChat(sessionId);
      const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
      ctx.setActiveOnEvent(onEvent);

      heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); else clearInterval(heartbeat); }, 15_000);
      ctx.setActiveBrowserSessionId(sessionId);

      const [contextBlock, relevantMemories] = await Promise.all([buildContextBlock(ctx.memoryIndex), autoSearchContext(ctx.memoryIndex, message)]);

      // Smart context from session summaries
      let smartContext = "";
      try {
        const summaryDir = join(ctx.dataDir, "memory", "session-summaries");
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
            if (scored.length > 0) smartContext = "\n\n--- RELATED PAST SESSIONS ---\n" + scored.map(s => s.content).join("\n---\n") + "\n--- END ---";
          }
        }
      } catch {}

      // Memory orchestrator
      let memoryContext = "";
      let memoryNotifications: Array<{type: string, message: string, priority: number}> = [];
      try {
        const { processMessage } = await import("../memory-orchestrator.js");
        const orch = await processMessage({
          message, sessionId,
          sessionMessages: session.messages.slice(-20).map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })),
          timeOfDay: new Date().getHours(), dayOfWeek: new Date().getDay(),
          agentPreviousMessage: session.messages.filter(m => m.role === "assistant").pop()?.content as string || undefined,
        });
        memoryContext = orch.contextInjection ? `\n\n${orch.contextInjection}` : "";
        memoryNotifications = orch.notifications || [];
        if (orch.debug) console.log(`[memory] Orchestrator: ${orch.debug.modulesActivated.length} modules, ${orch.debug.totalTimeMs}ms`);
      } catch (e) { console.warn("[memory] Orchestrator error:", (e as Error).message); }

      const threatEngine = new ThreatEngine(ctx.dataDir, sessionId);
      let canaryBuffer = "";
      let fullResponseText = "";

      const providerNames: Record<string, string> = { codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok", openai: "OpenAI", local: "Local (Ollama)" };
      const providerHint = `\n\n[System: You are currently powered by ${providerNames[provider] || provider}, model: ${savedModel || "default"}.]`;
      const integrationsContext = ctx.integrations.getAgentContext();

      let notificationHint = "";
      if (memoryNotifications.length > 0) {
        const topNotifs = memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
        notificationHint = "\n\n[Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | ") + "]";
      }

      // Tool prompt section (teaches LLM best practices per tool)
      let toolPromptSection = "";
      try { const { buildToolPromptSection } = await import("../tool-prompt-builder.js"); toolPromptSection = buildToolPromptSection(ctx.allAgentTools); } catch {}

      // Build system prompt via modular context builder (ordered sections, cacheable static parts)
      const { createChatContextBuilder } = await import("../context-builder.js");
      const contextBuilder = createChatContextBuilder({
        systemPrompt: ctx.config.systemPrompt,
        providerHint,
        toolPromptSection,
        contextBlock,
        relevantMemories,
        smartContext,
        memoryContext,
        notificationHint,
        integrationsContext,
        canaryBlock: threatEngine.getCanaryBlock(),
      });
      const enrichedPrompt = await contextBuilder.build();

      const uploadsDir = join(ctx.dataDir, "uploads");
      const imageAttachments = attachments.filter(a => a.isImage && a.url).map(a => {
        const fname = a.url.replace(/^\/uploads\//, "");
        return { name: a.name, url: a.url, filePath: join(uploadsDir, fname) };
      });

      // Sanitize orphaned tool results
      type MsgRecord = Record<string, unknown>;
      const sanitizeHistory = (msgs: typeof session.messages) => {
        const validCallIds = new Set<string>();
        const result = [];
        for (const m of msgs) {
          const rec = m as unknown as MsgRecord;
          if (m.role === "assistant" && rec.tool_calls) { for (const tc of rec.tool_calls as Array<{ id: string }>) validCallIds.add(tc.id); result.push(m); }
          else if (m.role === "tool") { if (rec.tool_call_id && validCallIds.has(rec.tool_call_id as string)) result.push(m); }
          else result.push(m);
        }
        return result;
      };

      // Context management
      const findSafeCutPoint = (msgs: typeof session.messages, targetIdx: number): number => {
        for (let i = targetIdx; i < msgs.length; i++) { if (msgs[i].role === "user") return i; }
        for (let i = targetIdx; i >= 0; i--) { if (msgs[i].role === "user") return i; }
        return targetIdx;
      };
      const buildSummary = (msgs: typeof session.messages): string => {
        const parts: string[] = [];
        for (const m of msgs) {
          if (m.role === "user" && typeof m.content === "string") parts.push(`User: ${m.content.slice(0, 150).replace(/\n/g, " ")}`);
          else if (m.role === "assistant" && typeof m.content === "string") parts.push(`Agent: ${m.content.split("\n").filter(l => l.trim())[0]?.slice(0, 150) || ""}`);
        }
        return `[Earlier in this conversation (${msgs.length} messages summarized):\n${parts.join("\n")}\n...end of summary]`;
      };

      let historyToSend = session.messages;
      const compactedSummary = session.compactedSummary;
      const compactedAt = session.compactedAt;
      if (compactedSummary && compactedAt) {
        const cutPoint = findSafeCutPoint(session.messages, compactedAt);
        historyToSend = [{ role: "system", content: compactedSummary } as ChatCompletionMessageParam, ...session.messages.slice(cutPoint)];
      } else if (session.messages.length > 40) {
        const cutPoint = findSafeCutPoint(session.messages, session.messages.length - 40);
        historyToSend = [{ role: "system", content: buildSummary(session.messages.slice(0, cutPoint)) } as ChatCompletionMessageParam, ...session.messages.slice(cutPoint)];
      }

      try { const { Handler: AO } = await import("../agency/handler.js"); AO.getInstance().currentSessionId = sessionId; } catch {}

      // IDE sessions: strip delegation tools so the agent works directly with file tools
      const IDE_BLOCKED_TOOLS = new Set(["agent_spawn", "delegate", "build_app", "agent_status", "agent_cancel", "agent_pause", "agent_resume", "agent_message"]);
      const isIdeSession = sessionId.startsWith("ide-");
      const sessionTools = isIdeSession ? ctx.allAgentTools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : ctx.allAgentTools;

      const result = await enqueue("main", () => runAgent(message, sanitizeHistory(historyToSend), {
        apiKey,
        model: savedModel || (provider === "codex" ? "gpt-5.3-codex" : provider === "anthropic" ? "claude-sonnet-4-6" : provider === "gemini" ? "gemini-2.0-flash" : ctx.config.model),
        provider, baseURL: customBaseURL, systemPrompt: enrichedPrompt,
        tools: sessionTools, security: ctx.security, toolPolicy: ctx.toolPolicy,
        threatEngine, rbac: ctx.rbac, callerRole: requestRole, sessionId,
        images: imageAttachments, maxIterations: savedMaxIterations || ctx.config.maxIterations,
        temperature: savedTemperature ?? ctx.config.temperature,
        signal: wsChat.abort.signal,
        onEvent: (event) => {
          if (event.type === "stream" && event.delta) {
            canaryBuffer += event.delta; fullResponseText += event.delta;
            if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
            const canaryTrip = threatEngine.checkOutput(canaryBuffer) || (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
            if (canaryTrip) { sseWrite(res, { type: "error", message: "Security alert: prompt injection detected." }); wsChat.abort.abort(); return; }
          }
          onEvent(event);
        },
      }), { label: `chat:${sessionId}`, timeout: 600_000 });

      ctx.setActiveOnEvent(undefined);
      // Clear any skill tool restrictions so they don't leak into the next message
      try { const { clearSessionAllowedTools } = await import("../session-policy.js"); clearSessionAllowedTools(sessionId); } catch {}
      session.messages = result.messages.filter((m) => m.role !== "system" && (m.content || (m as unknown as MsgRecord).tool_calls));
      session.updatedAt = Date.now();

      const assistantReply = result.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => m.content as string).join("\n");
      try { autoExtractAndSave(ctx.memoryIndex, message, assistantReply); } catch {}
      try {
        const userSnippet = message.slice(0, 300).replace(/\n/g, " ");
        const agentSnippet = assistantReply.slice(0, 300).replace(/\n/g, " ");
        if (userSnippet.length > 10) { ctx.memoryIndex.appendDailyLog(`[${sessionId}] User: ${userSnippet}`); if (agentSnippet.length > 10) ctx.memoryIndex.appendDailyLog(`[${sessionId}] Agent: ${agentSnippet}`); }
      } catch {}
      try {
        const { CrossSessionLearner } = await import("../cross-session-learning.js");
        const csl = CrossSessionLearner.getInstance();
        const toolCalls = result.messages.filter(m => (m as unknown as MsgRecord).tool_calls).flatMap(m => ((m as unknown as MsgRecord).tool_calls as Array<{ function?: { name: string }; name?: string }>) || []);
        for (const tc of toolCalls) csl.recordAction(sessionId, { type: "tool", details: tc.function?.name || tc.name || "unknown", timestamp: Date.now() });
      } catch {}

      ctx.saveSession(session);

      // Track real token usage and cost
      const realUsage = result.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let costUsd: number | undefined;
      try {
        const { trackUsage } = await import("../cost-tracker.js");
        const usedModel = savedModel || ctx.config.model;
        const record = trackUsage(sessionId, usedModel, provider, realUsage.promptTokens, realUsage.completionTokens);
        costUsd = record.costUsd;
      } catch {}
      sseWrite(res, { type: "done", usage: realUsage, ...(costUsd !== undefined ? { costUsd } : {}) } as ServerEvent);
      clearInterval(heartbeat);
      res.end();

      // Format output for bridge channels (plain text for WhatsApp/Telegram)
      let bridgeReply = assistantReply;
      try {
        const { formatOutput, detectStyle } = await import("../output-styles.js");
        const style = detectStyle(sessionId);
        if (style !== "rich") bridgeReply = formatOutput(assistantReply, style);
      } catch {}
      if (sessionId.startsWith("wa-") && bridgeReply) ctx.whatsappBridge.sendMessage(sessionId.slice(3), bridgeReply).catch(() => {});
      if (sessionId.startsWith("tg-") && bridgeReply) ctx.telegramBridge.sendMessage(sessionId.slice(3), bridgeReply).catch(() => {});
      ctx.agentSync.onChatEnd().catch(() => {});
    } catch (e) {
      // Clear skill restrictions on error too — don't leave session stuck in whitelist mode
      try { const { clearSessionAllowedTools } = await import("../session-policy.js"); clearSessionAllowedTools(sessionId); } catch {}
      sseWrite(res, { type: "error", message: safeErrorMessage(e) });
      sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
      clearInterval(heartbeat);
      res.end();
    }
    return true;
  }

  return false;
};
