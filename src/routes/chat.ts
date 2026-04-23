import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { isValidSessionId, safeErrorMessage, sseWrite, corsHeaders, jsonResponse, safeParseBody } from "../server-utils.js";
import { runAgent } from "../agent.js";
import { detectInjection } from "../sanitize.js";
import { ChatRequestSchema, CompactSchema, validateBody } from "../route-schemas.js";
import { ThreatEngine } from "../threat-engine.js";
import { enqueue } from "../execution-lanes.js";
import { autoExtractAndSave } from "../memory.js";

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
      const { prepareAgentRequest } = await import("../agent-request.js");

      // Unified request preparation: provider, context, history, tools — one call
      const prepared = await prepareAgentRequest({
        channel: sessionId.startsWith("ide-") ? "web" : "web",
        message, sessionMessages: session.messages, sessionId,
        config: ctx.config, dataDir: ctx.dataDir,
        memoryIndex: ctx.memoryIndex, integrations: ctx.integrations,
        secretsStore: ctx.secretsStore,
        allAgentTools: ctx.allAgentTools, bridgeTools: ctx.bridgeTools,
        attachments, uploadsDir: join(ctx.dataDir, "uploads"),
      });

      // Abort early if no API key
      if (!prepared.apiKey) {
        sseWrite(res, { type: "error", message: `No API key configured for ${prepared.provider}.` });
        res.end(); return true;
      }

      // IDE sessions: strip delegation tools
      const IDE_BLOCKED_TOOLS = new Set(["agent_spawn", "delegate", "build_app", "agent_status", "agent_cancel", "agent_pause", "agent_resume", "agent_message"]);
      const isIdeSession = sessionId.startsWith("ide-");
      const sessionTools = isIdeSession ? prepared.tools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : prepared.tools;

      const wsChat = ctx.chatWs.startChat(sessionId);
      const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
      ctx.setActiveOnEvent(onEvent);
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); else clearInterval(heartbeat); }, 15_000);
      ctx.setActiveBrowserSessionId(sessionId);

      try { const { Handler: AO } = await import("../agency/handler.js"); AO.getInstance().currentSessionId = sessionId; } catch {}

      // Threat engine canary (append to system prompt for injection detection)
      const threatEngine = new ThreatEngine(ctx.dataDir, sessionId);
      const systemPrompt = prepared.systemPrompt + threatEngine.getCanaryBlock();
      let canaryBuffer = "";
      let fullResponseText = "";

      const wrappedOnEvent = (event: ServerEvent) => {
        if (event.type === "stream" && event.delta) {
          canaryBuffer += event.delta; fullResponseText += event.delta;
          if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
          const canaryTrip = threatEngine.checkOutput(canaryBuffer) || (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
          if (canaryTrip) { sseWrite(res, { type: "error", message: "Security alert: prompt injection detected." }); wsChat.abort.abort(); return; }
        }
        onEvent(event);
      };

      // Wrap onEvent so `done` events from the PRIMARY provider are swallowed
      // until we know whether we need a fallback. Otherwise the UI closes
      // the SSE stream after the first provider's 'done' and misses any
      // fallback reply that follows.
      const primaryEventProxy = (event: ServerEvent) => {
        if (event.type === "done") return; // defer — we'll emit after fallback decision
        wrappedOnEvent(event);
      };
      const turnStart = Date.now();
      let result = await enqueue("main", () => runAgent(message, prepared.cleanHistory, {
        apiKey: prepared.apiKey, model: prepared.model,
        provider: prepared.provider as Parameters<typeof runAgent>[2]["provider"],
        baseURL: prepared.customBaseURL, systemPrompt,
        tools: sessionTools, security: ctx.security, toolPolicy: ctx.toolPolicy,
        threatEngine, rbac: ctx.rbac, callerRole: requestRole, sessionId,
        images: prepared.images, maxIterations: prepared.maxIterations,
        temperature: prepared.temperature, signal: wsChat.abort.signal,
        onEvent: primaryEventProxy,
      }), { label: `chat:${sessionId}`, timeout: 600_000 });
      const primaryElapsed = Date.now() - turnStart;
      console.log(`[timing] ${prepared.provider}/${prepared.model} primary ${primaryElapsed}ms`);

      // Auto-fallback triggers. Two classes:
      //   1. Empty-response: primary returned zero tokens/text/tool_calls.
      //   2. Transient error: primary threw a rate-limit / auth / overload /
      //      network error. These don't improve by retrying the same provider
      //      and almost always succeed on a different one.
      const lastAssistant = [...result.messages].reverse().find(m => m.role === "assistant");
      const emptyText = !lastAssistant || !lastAssistant.content || (typeof lastAssistant.content === "string" && !lastAssistant.content.trim());
      const noToolCalls = !((lastAssistant as unknown as { tool_calls?: unknown[] })?.tool_calls?.length);
      const zeroTokens = (result.usage?.completionTokens || 0) === 0;
      const isEmptyResponse = emptyText && noToolCalls && zeroTokens;

      const { classifyProviderError } = await import("../provider-fallback.js");
      const errKind = result.stopReason === "error" ? classifyProviderError(result.errorMessage || "") : null;
      const isTransientError = errKind !== null;

      if ((isEmptyResponse || isTransientError) && !wsChat.abort.signal.aborted) {
        const triggerKind = isTransientError ? errKind : "empty-response";
        try {
          const { logRetry } = await import("../retry-telemetry.js");
          const kind = isTransientError
            ? (errKind === "auth" ? "provider-auth-rotate" : "model-fallback")
            : "empty-response-fallback";
          logRetry({ kind, sessionId, provider: prepared.provider, model: prepared.model, detail: { trigger: triggerKind, errorMessage: result.errorMessage } });
        } catch {}
        const getKey = async (p: string): Promise<string | null> => {
          if (p === "codex") { const { loadTokens } = await import("../auth.js"); const t = loadTokens(); return t ? "cli" : null; }
          if (p === "anthropic") { const { loadAnthropicTokens } = await import("../auth-anthropic.js"); const t = loadAnthropicTokens(); return t ? "cli" : null; }
          if (p === "xai") return ctx.secretsStore.get("XAI_API_KEY") || null;
          if (p === "openai") return ctx.secretsStore.get("OPENAI_API_KEY") || ctx.config.openaiApiKey || null;
          if (p === "gemini") return ctx.secretsStore.get("GEMINI_API_KEY") || null;
          return null;
        };
        const fallbackOrder: Array<{ provider: string; model: string }> = [
          { provider: "codex", model: "gpt-5.4" },
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          { provider: "xai", model: "grok-4" },
        ].filter(f => f.provider !== prepared.provider);
        const reason = isTransientError
          ? (errKind === "rate-limit" ? "is rate-limited"
            : errKind === "auth" ? "auth expired"
            : errKind === "overload" ? "is overloaded"
            : "had a network error")
          : "returned nothing";
        for (const next of fallbackOrder) {
          const key = await getKey(next.provider);
          if (!key) continue;
          try {
            wrappedOnEvent({ type: "stream", delta: `\n\n_${prepared.provider} ${reason}. Retrying with ${next.provider} (${next.model})..._\n\n` });
            const fbStart = Date.now();
            result = await enqueue("main", () => runAgent(message, prepared.cleanHistory, {
              apiKey: key, model: next.model,
              provider: next.provider as Parameters<typeof runAgent>[2]["provider"],
              systemPrompt, tools: sessionTools, security: ctx.security, toolPolicy: ctx.toolPolicy,
              threatEngine, rbac: ctx.rbac, callerRole: requestRole, sessionId,
              images: prepared.images, maxIterations: prepared.maxIterations,
              temperature: prepared.temperature, signal: wsChat.abort.signal,
              // Swallow this fallback's 'done' too — we emit our own consolidated
              // done after the whole chain finishes (or we've decided no more retries).
              onEvent: (event: ServerEvent) => { if (event.type !== "done") wrappedOnEvent(event); },
            }), { label: `chat-fallback:${next.provider}:${sessionId}`, timeout: 600_000 });
            console.log(`[timing] ${next.provider}/${next.model} fallback ${Date.now() - fbStart}ms`);
            // Success condition depends on trigger: for empty-response we need
            // non-empty text; for transient errors we need anything that's not
            // another error.
            if (result.stopReason === "error") {
              const nextErr = classifyProviderError(result.errorMessage || "");
              if (nextErr !== null) continue; // still transient — try next provider
              break; // non-transient error: stop cascading
            }
            const newLast = [...result.messages].reverse().find(m => m.role === "assistant");
            const stillEmpty = !newLast || !newLast.content || (typeof newLast.content === "string" && !newLast.content.trim());
            const hasToolCalls = !!((newLast as unknown as { tool_calls?: unknown[] })?.tool_calls?.length);
            if (!stillEmpty || hasToolCalls) break;
          } catch (e) { console.warn(`[fallback] ${next.provider} failed: ${(e as Error).message}`); }
        }
      }

      ctx.setActiveOnEvent(undefined);
      // Clear any skill tool restrictions so they don't leak into the next message
      try { const { clearSessionAllowedTools } = await import("../session-policy.js"); clearSessionAllowedTools(sessionId); } catch {}
      const { stripEphemeralMessages } = await import("../agent-providers.js");
      type MsgRecord = Record<string, unknown>;
      // Keep system-stripped messages. Filter rules:
      // - Drop system messages (rebuilt per request)
      // - Keep all tool messages (the model needs them to interpret previous tool calls)
      // - Keep assistant messages with content OR tool_calls
      // - Drop empty user messages (sanity)
      session.messages = stripEphemeralMessages(result.messages).filter((m) => {
        if (m.role === "system") return false;
        if (m.role === "tool") return true; // never drop tool results
        return m.content || (m as unknown as MsgRecord).tool_calls;
      });
      session.updatedAt = Date.now();

      const assistantReply = result.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => m.content as string).join("\n");
      // Save memory for non-trivial messages
      const isTrivial = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) || /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
      if (!isTrivial) {
        try { autoExtractAndSave(ctx.memoryIndex, message, assistantReply); } catch {}
        try {
          const userSnippet = message.slice(0, 300).replace(/\n/g, " ");
          const agentSnippet = assistantReply.slice(0, 300).replace(/\n/g, " ");
          // Only log user messages as daily context — agent responses are action
          // confirmations, not facts. Logging them pollutes MIND.md when the
          // consolidator promotes frequently-seen strings ("Pinned Calendar" x3).
          // Also strip session IDs — they're internal metadata, not knowledge.
          if (userSnippet.length > 10) { ctx.memoryIndex.appendDailyLog(`User: ${userSnippet}`); }
        } catch {}
      }
      try {
        const { CrossSessionLearner } = await import("../cross-session-learning.js");
        const csl = CrossSessionLearner.getInstance();
        const toolCalls = result.messages.filter(m => (m as unknown as Record<string, unknown>).tool_calls).flatMap(m => ((m as unknown as Record<string, unknown>).tool_calls as Array<{ function?: { name: string }; name?: string }>) || []);
        for (const tc of toolCalls) csl.recordAction(sessionId, { type: "tool", details: tc.function?.name || tc.name || "unknown", timestamp: Date.now() });
      } catch {}

      ctx.saveSession(session);

      // Track real token usage and cost
      const realUsage = result.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let costUsd: number | undefined;
      try {
        const { trackUsage } = await import("../cost-tracker.js");
        const usedModel = prepared.model || ctx.config.model;
        const record = trackUsage(sessionId, usedModel, prepared.provider, realUsage.promptTokens, realUsage.completionTokens);
        costUsd = record.costUsd;
      } catch {}
      // Emit final done through BOTH channels (SSE + WebSocket). We swallowed
      // the primary and fallback 'done' events earlier so the UI didn't close
      // mid-chain; this is the consolidated turn-end signal.
      const doneEvent: ServerEvent = { type: "done", usage: realUsage, ...(costUsd !== undefined ? { costUsd } : {}) } as ServerEvent;
      wrappedOnEvent(doneEvent);
      console.log(`[timing] turn total ${Date.now() - turnStart}ms (${prepared.provider}/${prepared.model}, ${realUsage.totalTokens} tokens)`);
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
