import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { RouteHandler } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import { safeErrorMessage, sseWrite, corsHeaders, jsonResponse, safeParseBody } from "../server-utils.js";
import { ChatRequestSchema, validateBody } from "../route-schemas.js";
import { ThreatEngine } from "../threat-engine.js";
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
    // Stamp the chat's current project onto the session so agent_* tool
    // calls auto-scope. Frontend includes projectId on each request when
    // the chat is nested under a project; absent = global catalog.
    try {
      const projectId = (raw as Record<string, unknown>).projectId;
      const { setSessionProject } = await import("../session-project.js");
      setSessionProject(sessionId, typeof projectId === "string" ? projectId : null);
    } catch (e) {
      logger.warn(`[chat] failed to set session project: ${(e as Error).message}`);
    }

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
    const { tryAcquireOrReplace, releaseTurn: releaseTurnLock } = await import("../session-turn-lock.js");
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
      const { routeMessage, hasDiscussPrefix, stripDiscussPrefix } = await import("../routing/index.js");
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
        if (event.type === "stream" && "delta" in event && event.delta) {
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

      // Canonical-loop chat path. Every chat turn drives through canonical
      // — Anthropic + Codex + the OpenAI-compat providers all go through
      // the same machinery. Memory parity preserved; canonical observability
      // gained. Errors surface to the user; no silent fallback to legacy
      // (the legacy runAgent path + per-provider rescue chain was deleted
      // in P4.C5b ahead of P4.C6's removal of agent.ts).
      //
      // Codex's ChatGPT backend doesn't support `previous_response_id`, so
      // its adapter+convertMessages must include the assistant
      // `function_call` item alongside the tool_result so the API can match
      // call_ids. See chat-runner.ts / codex.ts.
      //
      // Snapshot session.messages before the canonical attempt. If the
      // canonical path throws partway through synthesis (e.g. memory
      // persist fails after we've already mutated session.messages), the
      // catch block reverts so the next turn starts from a known-good
      // state — never half-mutated. Cheap shallow copy; messages
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
        const { stripEphemeralMessages: stripCanonical } = await import("../providers/sanitize.js");
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
        // One-path policy: every chat turn takes canonical or fails — no
        // silent fallback to legacy runAgent. The fallback masked real
        // adapter bugs and produced inconsistent observability (some turns
        // canonical, some legacy, indistinguishable from outside). Surface
        // the error to the user; revert any partial session.messages
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
