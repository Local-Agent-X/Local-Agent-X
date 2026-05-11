import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { isValidSessionId, safeErrorMessage, sseWrite, corsHeaders, jsonResponse, safeParseBody } from "../server-utils.js";
import { runAgent } from "../agent.js";
import { detectInjection } from "../sanitize.js";
import { ChatRequestSchema, validateBody } from "../route-schemas.js";
import { ThreatEngine } from "../threat-engine.js";
import { enqueue } from "../execution-lanes.js";
import { logRetry } from "../retry-telemetry.js";
import { createLogger } from "../logger.js";
import { handleAutoDelegateRoutes } from "./chat/auto-delegate-routes.js";
import { handleCompactRoute } from "./chat/compact-route.js";
import { runDelegationHandoff } from "./chat/delegation-handoff.js";
import { tryWorkerRedirect } from "./chat/jarvis-redirect.js";

const logger = createLogger("routes.chat");

export const handleChatRoutes: RouteHandler = async (method, url, req, res, ctx, requestRole) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (await handleAutoDelegateRoutes(method, url, req, res)) return true;
  if (await handleCompactRoute(method, url, req, res, ctx)) return true;

  // Main chat SSE endpoint
  if (method === "POST" && url.pathname === "/api/chat") {
    const raw = await safeParseBody(req);
    if (!raw) { json(400, { error: "Invalid JSON body" }); return true; }
    const parsed = validateBody(raw, ChatRequestSchema);
    if (!parsed.success) { json(400, { error: parsed.error }); return true; }
    // message is optional in the schema (image-only sends are valid) — coerce to string
    let message = parsed.data.message ?? "";
    const _attachments = parsed.data.attachments;
    const sessionId = parsed.data.sessionId!;
    const attachments = _attachments!;

    // Slash-command interceptor. Runs BEFORE memory recall, history truncation,
    // or anything else that reads `message`. When the user typed `/<known-skill>`
    // (e.g. /app-build, /senior-engineer, /vibe-code), the SKILL.md body is
    // inlined as load-bearing methodology and the agent sees a rewritten
    // message. Unknown commands pass through unchanged so we don't swallow
    // legitimate slash-prefixed input. See src/slash-commands.ts.
    try {
      const { expandSlashCommand } = await import("../slash-commands.js");
      const expanded = expandSlashCommand(message);
      if (expanded) {
        logger.info(`[slash] /${expanded.command} expanded for sess=${sessionId.slice(0, 16)}${expanded.argText ? " (with arg)" : ""}`);
        message = expanded.agentMessage;
      }
    } catch (e) {
      logger.warn(`[slash] expansion failed (passing through): ${(e as Error).message}`);
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders(req) });

    // Wait for any in-flight write from a prior turn to land before reading
    // session state. Without this, a fast next-turn (e.g. user types "yes"
    // while the prior turn's saveSession is still queued) can race the LRU
    // cache: if the session was evicted between turns, getOrCreateSession
    // reloads from disk and gets stale bytes — losing the assistant's last
    // turn from history. flushSession is a no-op when nothing is pending.
    await ctx.flushSession(sessionId);
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
      const prepStart = Date.now();
      const prepared = await prepareAgentRequest({
        channel: sessionId.startsWith("ide-") ? "web" : "web",
        message, sessionMessages: session.messages, sessionId,
        config: ctx.config, dataDir: ctx.dataDir,
        memoryIndex: ctx.memoryIndex, memoryManager: ctx.memoryManager, integrations: ctx.integrations,
        secretsStore: ctx.secretsStore,
        allAgentTools: ctx.allAgentTools, bridgeTools: ctx.bridgeTools,
        attachments, uploadsDir: join(ctx.dataDir, "uploads"),
      });
      logger.info(`[timing] prepareAgentRequest ${Date.now() - prepStart}ms (sess=${sessionId.slice(0, 16)})`);

      // Emit a context_status event so the chat-bar gauge reflects actual
      // prompt size BEFORE the agent runs. Previously this only fired from
      // tool-executor's compaction check (i.e. mid-turn during tool use), so
      // text-only chat sessions saw "0% / 1000K" forever even with hundreds
      // of K of cached history. The UI was misleading users into thinking
      // their context was being flushed every turn.
      try {
        const { getContextStatus } = await import("../context-manager.js");
        const status = getContextStatus(prepared.cleanHistory, prepared.model);
        sseWrite(res, {
          type: "context_status",
          percentage: status.percentage,
          level: status.level,
          usedTokens: status.usedTokens,
          maxTokens: status.maxTokens,
          compacted: false,
        });
      } catch { /* best-effort telemetry */ }

      // Abort early if no API key — let finally emit done and end the response
      if (!prepared.apiKey) {
        sseWrite(res, { type: "error", message: `No API key configured for ${prepared.provider}.` });
        return true;
      }

      // Routing decision — single owner is src/routing/. Long tasks /
      // ship work / "create an app" patterns delegate to a fresh-context
      // worker subprocess; everything else runs inline. Regex rules +
      // LLM-as-classifier veto live entirely in src/routing/, no routing
      // logic should leak back into this file.
      const { routeMessage, delegateMessageToWorker, hasDiscussPrefix, stripDiscussPrefix, linkDecisionToOpId } = await import("../routing/index.js");
      // /discuss prefix is the user's explicit "stay inline this turn"
      // escape hatch. Strip it before passing to the agent so the model
      // doesn't see a literal "/discuss" in the message. routeMessage
      // also short-circuits on the prefix, but stripping here keeps the
      // agent's input clean even on the inline path.
      if (hasDiscussPrefix(message)) {
        message = stripDiscussPrefix(message);
      }

      // /discuss prefix is treated as an explicit override — user
      // wants to talk to main agent regardless of worker state.
      if (await tryWorkerRedirect({ sessionId, message, recentSessionMessages: session.messages, res })) {
        return true;
      }

      const routeDecision = await routeMessage(prepared.provider, message, "web");
      if (routeDecision.destination === "delegate") {
        const handoff = await runDelegationHandoff({
          message, sessionId, prepared, ctx, session, requestRole, res,
        });
        if (handoff.onEventInstalled) onEventInstalled = true;
        if (handoff.doneEmitted) doneEmitted = true;
        return true;
      }

      // IDE sessions: strip delegation tools
      const IDE_BLOCKED_TOOLS = new Set(["agent_spawn", "delegate", "build_app", "agent_status", "agent_cancel", "agent_pause", "agent_resume", "agent_message"]);
      const isIdeSession = sessionId.startsWith("ide-");
      let sessionTools = isIdeSession ? prepared.tools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : prepared.tools;

      // Lazy tool loading was here — stripped tools on conversational-looking
      // turns to recover ~1-2s of latency. Removed because the keyword regex
      // was a moving target: real example "go to x.com" got classified as
      // "no tool needed" (no `go to` in the keyword list) and the model
      // refused the navigation because it had no browser tool. Same trade as
      // the toolPromptSection revert — correctness over a 1-2s speed win.
      // Keep the full tool set for every chat turn; the model decides what
      // (if any) to call.

      const wsChat = ctx.chatWs.startChat(sessionId);
      const onEvent = (event: ServerEvent) => { sseWrite(res, event); wsChat.onEvent(event); };
      ctx.setActiveOnEvent(sessionId, onEvent);
      onEventInstalled = true;
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); else clearInterval(heartbeat); }, 15_000);
      ctx.setActiveBrowserSessionId(sessionId);

      // Session is plumbed via args._sessionId in tool-executor; no global needed.

      // Threat engine canary (append to system prompt for injection detection)
      const threatEngine = new ThreatEngine(ctx.dataDir, sessionId);
      let systemPrompt = prepared.systemPrompt + threatEngine.getCanaryBlock();

      // ── Step 3 of JARVIS-mode: parallel-worker awareness ──
      // If this inline turn is running WHILE one or more workers are
      // already going for this session, the agent should know about
      // them so it doesn't:
      //   - try to do the worker's job
      //   - claim the worker's output as its own
      //   - act surprised when the user references the worker
      // Architecture-wise the parallelism already works (worker runs in
      // its own subprocess on its own stream channel); this just adds
      // the conversational awareness so the agent behaves like a JARVIS
      // who knows what every other agent is busy with.
      try {
        const { listOpsForSession: listOpsAware } = await import("../workers/session-bridge.js");
        const { getOpTask: getOpTaskAware } = await import("../workers/session-bridge.js");
        const activeOpIds = listOpsAware(sessionId);
        if (activeOpIds.length > 0) {
          const taskLines = activeOpIds.map(id => {
            const t = getOpTaskAware(id) || "(unknown task)";
            return `  - ${t.slice(0, 160)}`;
          }).join("\n");
          systemPrompt += `\n\n[PARALLEL CONTEXT — ${activeOpIds.length} background worker${activeOpIds.length === 1 ? "" : "s"} active]\n` +
            `These workers are already running in separate processes for the user. You can SEE their progress streaming into the same chat. Do NOT try to do their work — they're already on it.\n\n` +
            `Active:\n${taskLines}\n\n` +
            `Respond to the user's CURRENT message normally. If they're asking something unrelated to the worker(s), answer it. If they're asking about a worker's status, you can refer to what you've seen in its progress stream. If they're giving feedback for a worker, that's already auto-routed via the redirect classifier — you don't need to handle it here. Speak naturally about the parallel context — like JARVIS would when Tony talks to him while a build is in progress.`;
        }
      } catch (e) {
        logger.warn(`[chat] parallel-worker awareness failed (proceeding without): ${(e as Error).message}`);
      }
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

      // Canonical-loop chat path. Gate: opt-in flag + Anthropic + no images
      // + canonical-loop interactive lane is on. The runner takes the SAME
      // prepared payload (memory, AGENTS, history, tools) and dispatches
      // through canonical-loop instead of the legacy runAgent → providers
      // chain. Memory parity is preserved; canonical observability is gained.
      // Edge cases that still go legacy: image attachments, providers without
      // canonical adapters, or any failure during canonical setup.
      //
      // Both Anthropic and Codex routed through canonical chat. Codex's
      // ChatGPT-backend doesn't support `previous_response_id`, so its
      // adapter+convertMessages must include the assistant `function_call`
      // item alongside the tool_result so the API can match call_ids.
      // See chat-runner.ts / codex.ts for the assistant tool_call message
      // finalization that makes the chain complete.
      // Every chat provider goes through canonical now. If a new provider
      // shows up (e.g. a future "ollama-fly" or "modal"), add it here AND
      // teach `resolveOpenAICompatTarget` how to map it. The legacy
      // runStandardAgent path is dead code post-this commit and slated
      // for removal.
      const CANONICAL_CHAT_PROVIDERS = new Set(["anthropic", "codex", "local", "ollama-cloud", "xai", "openai", "gemini", "custom"]);
      const canonicalChatEligible = await (async () => {
        try {
          const { isCanonicalChatEnabled, isCanonicalChatLaneEnabled } = await import("../canonical-loop/feature-flag.js");
          if (!isCanonicalChatEnabled()) return false;
          if (!isCanonicalChatLaneEnabled()) return false;
        } catch { return false; }
        if (!CANONICAL_CHAT_PROVIDERS.has(prepared.provider)) return false;
        return true;
      })();

      if (canonicalChatEligible) {
        // Snapshot session.messages before the canonical attempt. If the
        // canonical path throws partway through synthesis (e.g. memory
        // persist fails after we've already mutated session.messages), the
        // catch block reverts so the legacy fallback runs against a known-
        // good state — never half-mutated. Cheap shallow copy; messages
        // themselves are not mutated, only the array reference.
        const sessionMessagesSnapshot: ChatCompletionMessageParam[] = [...session.messages];
        try {
          const { runChatViaCanonical } = await import("../canonical-loop/index.js");
          const eventStream = runChatViaCanonical({
            message,
            sessionId,
            prepared,
            tools: sessionTools,
            security: ctx.security,
            toolPolicy: ctx.toolPolicy,
            threatEngine,
            rbac: ctx.rbac,
            callerRole: requestRole,
            onToolEvent: primaryEventProxy,
            signal: wsChat.abort.signal,
          });

          let canonicalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          // Capture the canonical op id when the runner emits chat_op_started.
          // Used at turn-end to read back any mid-turn injects from
          // op_messages and persist them to session.messages.
          let canonicalOpId = "";
          for await (const ev of eventStream) {
            if (ev.type === "done") {
              if (ev.usage) canonicalUsage = ev.usage;
              continue; // emit single done at end via primary path below
            }
            if (ev.type === "chat_op_started" && typeof ev.opId === "string") {
              canonicalOpId = ev.opId;
            }
            primaryEventProxy(ev);
          }
          const canonicalElapsed = Date.now() - turnStart;
          logger.info(`[timing] canonical/chat ${prepared.model} ${canonicalElapsed}ms (sess=${sessionId.slice(0, 16)})`);

          // Persist this turn to session.messages by reading the rows the
          // canonical loop produced for this op and appending the new ones
          // to the session log. We filter out seeded history (`hist-` prefix
          // — that's already in session.messages) and append everything else
          // in op_messages chronological order: original user message,
          // mid-turn injects, assistant tool_calls / tool_result / text rows.
          //
          // This replaces a string-only synthesis that previously lost
          // tool_calls and tool_result structure across turn boundaries —
          // canonical chats with tool use surfaced as text-only on next
          // turn, which broke "do that thing again" follow-ups. Reading
          // straight from op_messages preserves the full structured turn.
          //
          // Persist policy (split-gate, May 2026): user input always
          // persists, even if the assistant produced no text (aborted,
          // errored, or pure tool-only). Memory indexing still requires
          // assistant text since an empty turn isn't a meaningful Q/A pair.
          const assistantText = fullResponseText.trim();
          const { stripEphemeralMessages: stripCanonical } = await import("../agent-providers.js");
          type MsgRecordC = Record<string, unknown>;

          const newChatMessages: ChatCompletionMessageParam[] = [];
          if (canonicalOpId) {
            try {
              const { readOpMessages } = await import("../canonical-loop/store.js");
              const { opMessageRowToChatParam } = await import("../canonical-loop/chat-runner.js");
              const rows = readOpMessages(canonicalOpId);
              for (const row of rows) {
                if (row.messageId.startsWith("hist-")) continue;
                const param = opMessageRowToChatParam(row);
                if (param) newChatMessages.push(param);
              }
            } catch (e) {
              logger.warn(`[chat] canonical op-messages read failed: ${(e as Error).message}`);
            }
          }

          // Defensive fallback: if op_messages read failed (or produced no
          // rows), fall back to the legacy text-only synthesis for the
          // user message + assistant text. Never silently drop the user's
          // input — that's the original context-loss bug.
          if (newChatMessages.length === 0) {
            newChatMessages.push({ role: "user", content: message });
            if (assistantText) {
              newChatMessages.push({ role: "assistant", content: assistantText });
            }
          }

          const { COMPACTION_PREFIX: COMPACTION_PREFIX_CHAT } = await import("../types.js");
          session.messages = stripCanonical([...session.messages, ...newChatMessages]).filter((m) => {
            // Preserve a leading compaction summary system message — it's
            // the in-memory representation of a `summary` row in the
            // session log. Other system messages (canaries, threat-engine
            // markers, etc.) are stripped as before.
            if (m.role === "system") {
              return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX_CHAT);
            }
            if (m.role === "tool") return true;
            return m.content || (m as unknown as MsgRecordC).tool_calls;
          });
          session.updatedAt = Date.now();

          if (assistantText) {
            const isTrivialCanonical =
              /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
              /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
            try {
              await ctx.memoryManager.persistTurn({
                userMessage: message,
                agentResponse: assistantText,
                skip: isTrivialCanonical,
                sessionId,
              });
            } catch (persistErr) {
              logger.warn(`[chat] canonical persistTurn failed (proceeding): ${(persistErr as Error).message}`);
            }
          } else {
            logger.warn(`[chat] canonical turn produced no assistant text — persisting user turn only (sess=${sessionId.slice(0, 16)})`);
          }

          ctx.saveSession(session);

          // Emit terminal events through the wrapped path so the WS client
          // releases its turn lock and the SSE stream closes cleanly.
          wrappedOnEvent({ type: "done", usage: canonicalUsage });
          doneEmitted = true;
          return true;
        } catch (e) {
          // One-path policy: every canonical-eligible provider (anthropic,
          // codex, local) takes canonical or fails — no silent fallback to
          // legacy runAgent. The fallback masked real adapter bugs and
          // produced inconsistent observability (some turns canonical,
          // some legacy, indistinguishable from outside). Surface the
          // error to the user; revert any partial session.messages
          // mutation so the next turn starts from the right state.
          logger.error(`[chat] canonical chat path threw: ${(e as Error).message}`);
          session.messages = sessionMessagesSnapshot;
          session.updatedAt = Date.now();
          ctx.saveSession(session);
          sseWrite(res, { type: "error", message: `chat: ${(e as Error).message}` });
          sseWrite(res, { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
          doneEmitted = true;
          return true;
        }
      }

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
      // User setting: disable auto-fallback to other providers when the
      // primary fails. Default TRUE (failures stay visible so the user
      // knows their selected provider isn't working and can fix it).
      // The previous default was false (auto-rescue) but live testing
      // proved it hides reality: user on local/llama3:8b sees responses
      // looking fine, never realizes their local Ollama isn't producing
      // output and Anthropic is silently rescuing every turn.
      //
      // Set `disableProviderFallback: false` in settings.json to opt
      // back into the rescue chain (codex → anthropic → xai). Committing-
      // call protection is unconditional (always suppresses regardless
      // of this flag) since double-execute risk outweighs visibility.
      let disableProviderFallback = true;
      try {
        const { existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const sp = join(ctx.dataDir, "settings.json");
        if (existsSync(sp)) {
          const ss = JSON.parse(readFileSync(sp, "utf-8"));
          // Explicit `false` opts out of the new default; anything else
          // (true, missing, malformed) keeps fallback disabled.
          if (ss.disableProviderFallback === false) disableProviderFallback = false;
        }
      } catch { /* default stays true on any read error */ }

      const suppressFailover = committingCalls.length > 0 || disableProviderFallback;

      if (suppressFailover && (isEmptyResponse || isTransientError)) {
        const reasonText = isTransientError
          ? (errKind === "content-filter" ? "hit content moderation" : `had a ${errKind} issue${result.errorMessage ? `: ${result.errorMessage.slice(0, 200)}` : ""}`)
          : "returned an empty reply";
        let notice: string;
        if (committingCalls.length > 0) {
          // Committing-call suppression — keep existing message (auto-retry
          // would double-execute the action).
          const callList = committingCalls.slice(0, 3).map(c => `${c.toolName} (${c.reason})`).join(", ");
          notice =
            `\n\n_${prepared.provider} ${reasonText} AFTER already executing: ${callList}. ` +
            `Not auto-retrying on another provider — that could double-execute the action. ` +
            `If the action completed successfully, you're done. If it didn't, ask me to retry manually._\n\n`;
        } else {
          // disableProviderFallback suppression — clean failure surfaced to
          // the user so they can fix their provider config instead of
          // unknowingly running on a different model.
          notice =
            `\n\n**Error: ${prepared.provider}/${prepared.model} ${reasonText}.**\n\n` +
            `_Auto-fallback to other providers is disabled (\`disableProviderFallback: true\` in \`~/.lax/settings.json\`). ` +
            `Fix the provider — check Ollama is running, model is pulled, API key is valid — or toggle the setting back to \`false\` to re-enable the rescue chain (codex → anthropic → xai)._\n\n`;
        }
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
      const { COMPACTION_PREFIX: COMPACTION_PREFIX_LEG } = await import("../types.js");
      session.messages = stripEphemeralMessages(result.messages).filter((m) => {
        if (m.role === "system") {
          // Preserve compaction summaries (in-memory shape of a `summary`
          // row in the session log). Drop other system messages
          // (canaries, threat-engine markers, etc.).
          return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX_LEG);
        }
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
        sessionId,
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

      // End-of-turn memory pass — fire-and-forget. Decoupled from the
      // user-facing turn so memory writes don't compete with task
      // completion in the live model's attention. Runs a small classifier
      // call against the just-finished exchange, decides whether anything
      // memory-worthy happened, and writes server-side directly. User
      // already has their answer — this happens in the background.
      try {
        const { runEndOfTurnMemoryWrite } = await import("../memory/end-of-turn-write.js");
        void runEndOfTurnMemoryWrite({
          sessionId,
          userMessage: message,
          assistantReply,
          provider: prepared.provider,
          model: prepared.model,
          apiKey: prepared.apiKey,
        });
      } catch { /* end-of-turn write is best-effort */ }

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
