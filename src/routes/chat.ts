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
import { logRetry } from "../retry-telemetry.js";
import { createLogger } from "../logger.js";

const logger = createLogger("routes.chat");

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
    // message is optional in the schema (image-only sends are valid) — coerce to string
    const message = parsed.data.message ?? "";
    const _attachments = parsed.data.attachments;
    const sessionId = parsed.data.sessionId!;
    const attachments = _attachments!;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(req) });

    const session = ctx.getOrCreateSession(sessionId);
    if (session.messages.length === 0) session.title = message.slice(0, 60) + (message.length > 60 ? "..." : "");

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let doneEmitted = false;
    let lockHeld = false;
    let onEventInstalled = false;
    const { tryAcquireOrReplace, markIteration: markTurnIteration, releaseTurn: releaseTurnLock } = await import("../session-turn-lock.js");
    try {
      const { prepareAgentRequest } = await import("../agent-request.js");

      // Unified request preparation: provider, context, history, tools — one call
      const prepared = await prepareAgentRequest({
        channel: sessionId.startsWith("ide-") ? "web" : "web",
        message, sessionMessages: session.messages, sessionId,
        config: ctx.config, dataDir: ctx.dataDir,
        memoryIndex: ctx.memoryIndex, memoryManager: ctx.memoryManager, integrations: ctx.integrations,
        secretsStore: ctx.secretsStore,
        allAgentTools: ctx.allAgentTools, bridgeTools: ctx.bridgeTools,
        attachments, uploadsDir: join(ctx.dataDir, "uploads"),
        compactedSummary: session.compactedSummary,
        compactedAt: session.compactedAt,
      });

      // Abort early if no API key — let finally emit done and end the response
      if (!prepared.apiKey) {
        sseWrite(res, { type: "error", message: `No API key configured for ${prepared.provider}.` });
        return true;
      }

      // Fix E: auto-delegate long tasks to the worker pool when running on
      // Codex (drift-prone) and prepare-request's Fix D didn't escape to
      // Anthropic. The worker runs in a subprocess with a fresh context,
      // dramatically reducing the context-bloat drift that causes Codex to
      // lose the original task on long agentic loops. Same model, smaller
      // failure surface.
      const { shouldAutoDelegate, delegateMessageToWorker } = await import("../workers/auto-delegate.js");
      if (shouldAutoDelegate(prepared.provider, message, "web")) {
        const { opId, replyText } = await delegateMessageToWorker(message, sessionId);
        // Set up a minimal onEvent path so the SSE stream gets the reply
        // and the chat session buffers it (so reconnects + completion
        // notifications land in the same conversation thread).
        const wsChat = ctx.chatWs.startChat(sessionId);
        const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
        ctx.setActiveOnEvent(sessionId, onEvent);
        onEventInstalled = true;
        onEvent({ type: "stream", delta: replyText });
        // Persist the user message + synthetic assistant reply so the next
        // chat turn sees the routing decision in history (and so the user
        // can scroll back to the "started in worker" notice).
        session.messages.push({ role: "user", content: message });
        session.messages.push({ role: "assistant", content: replyText });
        session.updatedAt = Date.now();
        ctx.saveSession(session);
        // Push a card into the global agents sidebar so the user can watch
        // the op live without it polluting the chat thread. Broadcast via
        // chat-ws so all connected sessions see it (matches how regular
        // sub-agents surface in the same panel).
        try {
          const { broadcastAll } = await import("../chat-ws.js");
          broadcastAll({
            type: "event",
            sessionId,
            event: { type: "bg_op_started", opId, task: message.slice(0, 200), provider: prepared.provider },
          });
        } catch {}
        onEvent({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        doneEmitted = true;
        logger.info(`[router] Auto-delegated to worker pool: op=${opId} sess=${sessionId} provider=${prepared.provider}`);
        return true;
      }

      // IDE sessions: strip delegation tools
      const IDE_BLOCKED_TOOLS = new Set(["agent_spawn", "delegate", "build_app", "agent_status", "agent_cancel", "agent_pause", "agent_resume", "agent_message"]);
      const isIdeSession = sessionId.startsWith("ide-");
      const sessionTools = isIdeSession ? prepared.tools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : prepared.tools;

      const wsChat = ctx.chatWs.startChat(sessionId);
      const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
      ctx.setActiveOnEvent(sessionId, onEvent);
      onEventInstalled = true;
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); else clearInterval(heartbeat); }, 15_000);
      ctx.setActiveBrowserSessionId(sessionId);

      // Session is plumbed via args._sessionId in tool-executor; no global needed.

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
      // Per-session turn lock. If a previous turn is still running for this
      // session, we either (a) abort it when it hasn't committed anything yet
      // and replace it with this new turn, or (b) refuse this new message
      // with a 409-shaped error when the previous turn is mid-commit (email
      // send, browser click on Send/Submit, etc). The lock is released in
      // the finally block below, regardless of how the turn ends.
      const decision = await tryAcquireOrReplace(sessionId, wsChat.abort, `chat:${prepared.provider}`);
      if (!decision.allowed) {
        const prev = decision.previous!;
        wrappedOnEvent({
          type: "error",
          message:
            `Your previous request is still running (started ${Math.round(prev.elapsedMs / 1000)}s ago, ` +
            `iteration ${prev.iteration}, last action ${prev.lastToolName || "in progress"}). ` +
            `Cancel it first or wait for it to finish.`,
        });
        wrappedOnEvent({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        doneEmitted = true;
        return true;
      }
      lockHeld = true;
      if (decision.reason === "aborted-non-committing") {
        logger.info(`[turn-lock] aborted prior non-committing turn for sess=${sessionId} (was ${decision.previous?.elapsedMs}ms in, iter=${decision.previous?.iteration})`);
      }
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
      }), { label: `chat:${sessionId}`, timeout: 1_800_000 });
      // Expose mark helper to the agent loops via module import (done inside the loops)
      void markTurnIteration;
      const primaryElapsed = Date.now() - turnStart;
      logger.info(`[timing] ${prepared.provider}/${prepared.model} primary ${primaryElapsed}ms`);

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

      // Double-send guard: if the turn already performed a committing tool
      // call (email send, HTTP POST/PUT/DELETE, browser click on Send/Submit/
      // Pay/Delete, secret/memory/cron mutations, etc.), DO NOT auto-failover.
      // Replaying the turn on a different provider would re-execute the call.
      // Surface the error to the user instead.
      const { detectCommittingCalls } = await import("../committing-tool-check.js");
      const committingCalls = detectCommittingCalls(result.messages);
      const suppressFailover = committingCalls.length > 0;

      if (suppressFailover && (isEmptyResponse || isTransientError)) {
        const callList = committingCalls.slice(0, 3).map(c => `${c.toolName} (${c.reason})`).join(", ");
        const reasonText = isTransientError
          ? (errKind === "content-filter" ? "hit content moderation" : `had a ${errKind} issue`)
          : "returned an empty reply";
        const notice =
          `\n\n_${prepared.provider} ${reasonText} AFTER already executing: ${callList}. ` +
          `Not auto-retrying on another provider — that could double-execute the action. ` +
          `If the action completed successfully, you're done. If it didn't, ask me to retry manually._\n\n`;
        wrappedOnEvent({ type: "stream", delta: notice });
        logRetry({ kind: "custom", sessionId, provider: prepared.provider, model: prepared.model, detail: { reason: "failover-suppressed-committing-call", committingCalls: committingCalls.map(c => c.toolName) } });
      }

      if ((isEmptyResponse || isTransientError) && !suppressFailover && !wsChat.abort.signal.aborted) {
        const triggerKind = isTransientError ? errKind : "empty-response";
        const kind = isTransientError
          ? (errKind === "auth" ? "provider-auth-rotate" : "model-fallback")
          : "empty-response-fallback";
        logRetry({ kind, sessionId, provider: prepared.provider, model: prepared.model, detail: { trigger: triggerKind, errorMessage: result.errorMessage } });
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
            : errKind === "content-filter" ? "hit content moderation on this context"
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
            }), { label: `chat-fallback:${next.provider}:${sessionId}`, timeout: 1_800_000 });
            logger.info(`[timing] ${next.provider}/${next.model} fallback ${Date.now() - fbStart}ms`);
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
          } catch (e) { logger.warn(`[fallback] ${next.provider} failed: ${(e as Error).message}`); }
        }
      }

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
      const isTrivial = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) || /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
      await ctx.memoryManager.persistTurn({
        userMessage: message,
        agentResponse: assistantReply,
        skip: isTrivial,
      });
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
      doneEmitted = true;
      logger.info(`[timing] turn total ${Date.now() - turnStart}ms (${prepared.provider}/${prepared.model}, ${realUsage.totalTokens} tokens)`);

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
      if (!res.writableEnded) {
        sseWrite(res, { type: "error", message: safeErrorMessage(e) });
      }
    } finally {
      // Single cleanup path for every exit (success, error, early return).
      // Each guard tracks whether the corresponding setup ran so we don't
      // release/clear something that was never acquired.
      if (lockHeld) releaseTurnLock(sessionId);
      if (onEventInstalled) ctx.setActiveOnEvent(sessionId, undefined);
      if (heartbeat) clearInterval(heartbeat);
      // Reset the legacy activeBrowserSessionId getter to "default" so it
      // can't bleed into a future session that lacks _sessionId injection.
      ctx.setActiveBrowserSessionId("default");
      try {
        const { clearSessionAllowedTools } = await import("../session-policy.js");
        clearSessionAllowedTools(sessionId);
      } catch {}
      if (!doneEmitted && !res.writableEnded) {
        sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
      }
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  return false;
};
