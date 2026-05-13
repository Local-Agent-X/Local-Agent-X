import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ServerContext } from "../../server-context.js";
import type { Role } from "../../rbac.js";
import type { ServerEvent } from "../../types.js";
import { safeErrorMessage } from "../../server-utils.js";
import { ThreatEngine } from "../../threat-engine.js";
import { createLogger } from "../../logger.js";
import { runDelegationHandoff } from "./delegation-handoff.js";
import { tryWorkerRedirect } from "./jarvis-redirect.js";
import { createRetryContext, attachRetryContext, detachRetryContext } from "../../retry-context.js";

const logger = createLogger("routes.chat.run-turn");

// Directive verbs that signal "the user is explicitly directing this
// attachment to a destination" — when paired with attachments, this is
// the consent signal for the threat-engine's user-consent bypass. The
// list is conservative on purpose: a vague "look at this" doesn't fire;
// "enter / submit / send / post / upload / paste / fill / add this in/to/into
// <somewhere>" does.
const DIRECTIVE_VERB_RE = /\b(enter|submit|send|post|upload|paste|fill|add|put|record|log|register|copy)\b[^.!?]{0,80}\b(in|to|into|via|onto|inside|under|using|through)\b/i;

/**
 * Transport-agnostic sink for outbound chat events. The HTTP route handler
 * passes one that writes SSE frames to its `res`; the WS forward layer passes
 * `null` because the WS client receives events via chat-ws's own pub/sub
 * (broadcastToSession) which is wired up inside this function via
 * `ctx.chatWs.startChat(sessionId)`. Passing `null` is not a bug — it's the
 * "WS-only" mode where the SSE side-channel is intentionally absent.
 */
export type SseSink = ((event: ServerEvent) => void) | null;

export interface RunChatTurnArgs {
  sessionId: string;
  message: string;
  /** Attachments validated by ChatRequestSchema for HTTP, or passed
   *  through from the WS frame. Loose-typed because the canonical
   *  prepareAgentRequest accepts arbitrary attachment shapes. */
  attachments: Array<{ name: string; url: string; isImage: boolean }>;
  projectId: unknown;
  ctx: ServerContext;
  requestRole: Role;
  /** SSE side-channel sink. Pass null for WS-only delivery. */
  sseSink: SseSink;
}

/**
 * Execute a single chat turn. This is the transport-agnostic core that used
 * to live inline in the POST /api/chat handler. Two callers:
 *
 *   - HTTP route handler (src/routes/chat.ts): passes `sseSink = (ev) => sseWrite(res, ev)`
 *     so the SSE response body matches the legacy contract for non-WS clients
 *     (Telegram / WhatsApp / curl).
 *
 *   - WS forward layer (src/server/lifecycle.ts wireWsChat): passes
 *     `sseSink = null` because the WS client receives events through chat-ws's
 *     own subscription (set up by `ctx.chatWs.startChat(sessionId)` below).
 *     Eliminates the localhost HTTP self-loop that used to live in wireWsChat.
 *
 * Behavior is identical to the previous inline body: slash expansion,
 * project stamping, prepareAgentRequest, JARVIS redirect, auto-delegation,
 * canonical-loop run, turn-lock, message persistence, memory write,
 * finally-block cleanup. The only thing not owned here is HTTP-specific
 * setup (writeHead, heartbeat, res.end) — that stays at the route boundary.
 */
export async function runChatTurn(args: RunChatTurnArgs): Promise<void> {
  const { sessionId, attachments, projectId, ctx, requestRole, sseSink } = args;
  let message = args.message;

  // Helper to emit an event through the SSE sink only. WS-side delivery
  // happens via wsChat.onEvent (installed below).
  const emitSse = (event: ServerEvent) => { if (sseSink) sseSink(event); };

  // Stamp the chat's current project onto the session so agent_* tool
  // calls auto-scope. Frontend includes projectId on each request when
  // the chat is nested under a project; absent = global catalog.
  try {
    const { setSessionProject } = await import("../../session-project.js");
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
  // `/approve <reason>` short-circuit. Grants threat-engine consent for
  // this session so the model's NEXT retry of a blocked tool succeeds.
  // Returns inline to the chat, doesn't call the model. Layer B of the
  // threat-engine consent flow. See src/threat/consent-store.ts.
  if (/^\s*\/approve\b/i.test(message)) {
    const reason = (message.replace(/^\s*\/approve\s*/i, "").trim() || "user-typed-/approve").slice(0, 160);
    const { grantConsent, getLastBlockedFingerprint } = await import("../../threat/consent-store.js");
    grantConsent(sessionId, 30 * 60_000, reason);
    // Layer C: record the last blocked pattern's fingerprint into the
    // trust ledger so future sessions auto-allow without /approve.
    let ledgerNote = "";
    const fp = getLastBlockedFingerprint(sessionId);
    if (fp) {
      const { recordApproval } = await import("../../threat/trust-ledger.js");
      recordApproval(fp, reason);
      ledgerNote = `\n\nLearned pattern: \`${fp}\` — future sessions hitting this pattern will auto-allow without /approve.`;
    }
    logger.info(`[threat] /approve granted for sess=${sessionId.slice(0, 16)}: ${reason.slice(0, 80)}${fp ? ` (ledger fingerprint=${fp})` : ""}`);
    if (sseSink) sseSink({
      type: "stream",
      delta: `✓ Consent granted for 30 minutes. Reason: ${reason}\n\nThe agent's next retry of the blocked tool will succeed. Type the original request again or ask the agent to retry.${ledgerNote}`,
    });
    if (sseSink) sseSink({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    return;
  }

  try {
    const { expandSlashCommand } = await import("../../slash-commands.js");
    const expanded = expandSlashCommand(message);
    if (expanded) {
      logger.info(`[slash] /${expanded.command} expanded for sess=${sessionId.slice(0, 16)}${expanded.argText ? " (with arg)" : ""}`);
      message = expanded.agentMessage;
    }
  } catch (e) {
    logger.warn(`[slash] expansion failed (passing through): ${(e as Error).message}`);
  }

  // Wait for any in-flight write from a prior turn to land before reading
  // session state. Without this, a fast next-turn (e.g. user types "yes"
  // while the prior turn's saveSession is still queued) can race the LRU
  // cache: if the session was evicted between turns, getOrCreateSession
  // reloads from disk and gets stale bytes — losing the assistant's last
  // turn from history. flushSession is a no-op when nothing is pending.
  await ctx.flushSession(sessionId);
  const session = ctx.getOrCreateSession(sessionId);
  if (session.messages.length === 0) session.title = message.slice(0, 60) + (message.length > 60 ? "..." : "");

  let doneEmitted = false;
  let lockHeld = false;
  let onEventInstalled = false;
  let retryCtxAttached = false;
  // One RetryContext per chat turn. Today only L1 (tool-executor's withRetry
  // for transient-network tools) reads it; the correlationId stitches its
  // log lines for this turn. See src/retry-context.ts for history.
  const retryCtx = createRetryContext();
  attachRetryContext(sessionId, retryCtx);
  retryCtxAttached = true;
  logger.info(`[retry] correlationId=${retryCtx.correlationId} sess=${sessionId.slice(0, 16)}`);
  const { tryAcquireOrReplace, releaseTurn: releaseTurnLock } = await import("../../session-turn-lock.js");
  try {
    const { prepareAgentRequest } = await import("../../agent-request.js");

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
    // prompt size BEFORE the agent runs. Fan out to BOTH transports —
    // SSE clients (Telegram/WhatsApp/curl) get `emitSse`, WS clients (the
    // chat UI, which uses sseSink=null) get `ctx.chatWs.emit`. Until this
    // dual-emit was added, WS clients never saw a fresh context_status
    // unless compaction fired, so the bottom-of-chat gauge stayed at the
    // 0K/128K fallback for every normal turn. (chat-status-bar.js falls
    // back to that placeholder when window.lastContextStatus is null.)
    try {
      const { getContextStatus } = await import("../../context-manager.js");
      const status = getContextStatus(prepared.cleanHistory, prepared.model);
      const ev = {
        type: "context_status" as const,
        percentage: status.percentage,
        level: status.level,
        usedTokens: status.usedTokens,
        maxTokens: status.maxTokens,
        compacted: false,
      };
      emitSse(ev);
      ctx.chatWs.emit(sessionId, ev);
    } catch { /* best-effort telemetry */ }

    // Abort early if no API key — let finally emit done.
    if (!prepared.apiKey) {
      emitSse({ type: "error", message: `No API key configured for ${prepared.provider}.` });
      return;
    }

    const { routeMessage, hasDiscussPrefix, stripDiscussPrefix } = await import("../../routing/index.js");
    if (hasDiscussPrefix(message)) {
      message = stripDiscussPrefix(message);
    }

    if (await tryWorkerRedirect({ sessionId, message, recentSessionMessages: session.messages, sseSink })) {
      return;
    }

    const routeDecision = await routeMessage(prepared.provider, message, "web");
    if (routeDecision.destination === "delegate") {
      const handoff = await runDelegationHandoff({
        message, sessionId, prepared, ctx, session, requestRole, sseSink,
      });
      if (handoff.onEventInstalled) onEventInstalled = true;
      if (handoff.doneEmitted) doneEmitted = true;
      return;
    }

    // IDE sessions: strip delegation tools
    const IDE_BLOCKED_TOOLS = new Set(["agent_spawn", "delegate", "build_app", "agent_status", "agent_cancel", "agent_pause", "agent_resume", "agent_message"]);
    const isIdeSession = sessionId.startsWith("ide-");
    const sessionTools = isIdeSession ? prepared.tools.filter(t => !IDE_BLOCKED_TOOLS.has(t.name)) : prepared.tools;

    const wsChat = ctx.chatWs.startChat(sessionId);
    const onEvent = (event: ServerEvent) => { emitSse(event); wsChat.onEvent(event); };
    ctx.setActiveOnEvent(sessionId, onEvent);
    onEventInstalled = true;
    ctx.setActiveBrowserSessionId(sessionId);

    const threatEngine = new ThreatEngine(ctx.dataDir, sessionId);
    // Threat-engine consent gating. Two paths can grant consent:
    //  1) Layer A — this turn's message has attachments + directive verbs
    //  2) Layer B — a prior turn granted consent via /approve, still in window
    // Either way we seed the per-turn analyzer so exfil patterns audit-but-
    // don't-block. Live failure 2026-05-13 (invoice PDF → Thrivemetrics)
    // motivates Layer A; the /approve flow handles cases Layer A misses.
    const { grantConsent, getActiveConsent } = await import("../../threat/consent-store.js");
    if (attachments.length > 0 && DIRECTIVE_VERB_RE.test(message)) {
      grantConsent(sessionId, 30 * 60_000, `chat-attachment-with-directive (attachments=${attachments.length})`);
    }
    const activeConsent = getActiveConsent(sessionId);
    if (activeConsent) {
      threatEngine.markUserConsentFlow(activeConsent.remainingMs, activeConsent.reason);
    }
    const { augmentSystemPrompt } = await import("./system-prompt-augmentations.js");
    await augmentSystemPrompt(prepared, threatEngine, sessionId);

    let canaryBuffer = "";
    let fullResponseText = "";

    const wrappedOnEvent = (event: ServerEvent) => {
      if (event.type === "stream" && "delta" in event && event.delta) {
        canaryBuffer += event.delta; fullResponseText += event.delta;
        if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
        const canaryTrip = threatEngine.checkOutput(canaryBuffer) || (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
        if (canaryTrip) { emitSse({ type: "error", message: "Security alert: prompt injection detected." }); wsChat.abort.abort(); return; }
      }
      onEvent(event);
    };

    // Wrap onEvent so `done` events from the PRIMARY provider are swallowed
    // until we know whether we need a fallback. Otherwise the UI closes
    // the stream after the first provider's 'done' and misses any fallback.
    const primaryEventProxy = (event: ServerEvent) => {
      if (event.type === "done") return; // defer — we'll emit after fallback decision
      wrappedOnEvent(event);
    };

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
      return;
    }
    lockHeld = true;
    if (decision.reason === "aborted-non-committing") {
      logger.info(`[turn-lock] aborted prior non-committing turn for sess=${sessionId} (was ${decision.previous?.elapsedMs}ms in, iter=${decision.previous?.iteration})`);
    }
    const turnStart = Date.now();

    try {
      const { runChatViaCanonical } = await import("../../canonical-loop/index.js");
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
      let canonicalOpId = "";
      for await (const ev of eventStream) {
        if (ev.type === "done") {
          if (ev.usage) canonicalUsage = ev.usage;
          continue;
        }
        if (ev.type === "chat_op_started" && typeof ev.opId === "string") {
          canonicalOpId = ev.opId;
        }
        primaryEventProxy(ev);
      }
      const canonicalElapsed = Date.now() - turnStart;
      logger.info(`[timing] canonical/chat ${prepared.model} ${canonicalElapsed}ms (sess=${sessionId.slice(0, 16)})`);

      const assistantText = fullResponseText.trim();
      const { stripEphemeralMessages: stripCanonical } = await import("../../providers/sanitize.js");
      type MsgRecordC = Record<string, unknown>;

      const newChatMessages: ChatCompletionMessageParam[] = [];
      if (canonicalOpId) {
        try {
          const { readOpMessages } = await import("../../canonical-loop/store.js");
          const { opMessageRowToChatParam } = await import("../../canonical-loop/chat-runner.js");
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

      // Defensive fallback: never silently drop the user's input.
      if (newChatMessages.length === 0) {
        newChatMessages.push({ role: "user", content: message });
        if (assistantText) {
          newChatMessages.push({ role: "assistant", content: assistantText });
        }
      }

      const { COMPACTION_PREFIX: COMPACTION_PREFIX_CHAT } = await import("../../types.js");
      session.messages = stripCanonical([...session.messages, ...newChatMessages]).filter((m) => {
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

      wrappedOnEvent({ type: "done", usage: canonicalUsage });
      doneEmitted = true;
      return;
    } catch (e) {
      logger.error(`[chat] canonical chat path threw: ${(e as Error).message}`);
      emitSse({ type: "error", message: `chat: ${(e as Error).message}` });
      emitSse({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
      doneEmitted = true;
      return;
    }
  } catch (e) {
    emitSse({ type: "error", message: safeErrorMessage(e) });
  } finally {
    if (lockHeld) releaseTurnLock(sessionId);
    if (onEventInstalled) ctx.setActiveOnEvent(sessionId, undefined);
    if (retryCtxAttached) detachRetryContext(sessionId);
    ctx.setActiveBrowserSessionId("default");
    try {
      const { clearSessionAllowedTools } = await import("../../session-policy.js");
      clearSessionAllowedTools(sessionId);
    } catch {}
    if (!doneEmitted) {
      // Final safety net. Reach BOTH channels so neither an HTTP client
      // nor a WS subscriber is left hanging if we crashed before the
      // wrappedOnEvent path got to emit done.
      emitSse({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
      try { ctx.chatWs.failChat(sessionId, "Chat ended unexpectedly."); } catch {}
    }
  }
}
