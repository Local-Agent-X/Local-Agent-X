import type { ServerEvent } from "../../../types.js";
import { safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { runDelegationHandoff } from "../delegation-handoff.js";
import { tryWorkerRedirect } from "../jarvis-redirect.js";
import { createRetryContext, attachRetryContext, detachRetryContext } from "../../../retry-context.js";
import type { RunChatTurnArgs } from "./types.js";
import { handleApproveCommand, expandSlash } from "./slash-interceptors.js";
import {
  preparePerTurnRequest, emitContextStatus,
  filterToolsForSession, applyDiscussPrefix,
} from "./prepare-and-route.js";
import { installEventWiring } from "./event-wiring.js";
import { runCanonicalChat } from "./canonical-run.js";

const logger = createLogger("routes.chat.run-turn");

/**
 * Execute a single chat turn. Transport-agnostic core. Three callers:
 *
 *   - HTTP route handler (src/routes/chat.ts): passes `sseSink = (ev) => sseWrite(res, ev)`
 *     so the SSE response body matches the legacy contract for non-WS clients
 *     (browser fallback / curl).
 *
 *   - WS forward layer (src/server/lifecycle.ts wireWsChat): passes
 *     `sseSink = null` because the WS client receives events through chat-ws's
 *     own subscription (set up by `ctx.chatWs.startChat(sessionId)`).
 *     Eliminates the localhost HTTP self-loop that used to live in wireWsChat.
 *
 *   - Inbound messaging adapter (src/server/inbound-channel-runner.ts): captures
 *     canonical events for Telegram/WhatsApp replies without a shadow agent loop.
 *
 * Behavior is identical to the previous inline body: slash expansion,
 * project stamping, prepareAgentRequest, JARVIS redirect, auto-delegation,
 * canonical-loop run, turn-lock, message persistence, memory write,
 * finally-block cleanup. The only thing not owned here is HTTP-specific
 * setup (writeHead, heartbeat, res.end) — that stays at the route boundary.
 */
export async function runChatTurn(args: RunChatTurnArgs): Promise<void> {
  const { sessionId, attachments, projectId, ctx, requestRole, sseSink } = args;
  const channel = args.channel ?? "web";
  let message = args.message;

  const emitSse = (event: ServerEvent) => { if (sseSink) sseSink(event); };

  // Stamp the chat's current project onto the session so agent_* tool
  // calls auto-scope. Frontend includes projectId on each request when
  // the chat is nested under a project; absent = global catalog.
  try {
    const { setSessionProject } = await import("../../../session/project.js");
    setSessionProject(sessionId, typeof projectId === "string" ? projectId : null);
  } catch (e) {
    logger.warn(`[chat] failed to set session project: ${(e as Error).message}`);
  }

  const approve = await handleApproveCommand(message, sessionId, sseSink);
  if (approve.handled) return;

  message = await expandSlash(message, sessionId);

  // Fresh user turn → a message while cards were pending means the user
  // answered in words, not clicks: deny those cards (without suppression, so
  // the model can re-raise after reading the reply). Then drop any
  // decline-suppression from the prior turn's tool loop, so a deliberate
  // re-request ("yes, delete it") prompts normally.
  try {
    const { getApprovalManager } = await import("../../../approval-manager.js");
    getApprovalManager().denyPendingForSession(sessionId);
    getApprovalManager().clearDeclines(sessionId);
  } catch {}

  // Wait for any in-flight write from a prior turn to land before reading
  // session state. Without this, a fast next-turn (e.g. user types "yes"
  // while the prior turn's saveSession is still queued) can race the LRU
  // cache: if the session was evicted between turns, getOrCreateSession
  // reloads from disk and gets stale bytes — losing the assistant's last
  // turn from history. flushSession is a no-op when nothing is pending.
  await ctx.flushSession(sessionId);
  const session = ctx.getOrCreateSession(sessionId);
  if (session.messages.length === 0) {
    session.title = args.sessionTitle ?? (message.slice(0, 60) + (message.length > 60 ? "..." : ""));
  }

  // Persist the chat→project link onto the durable session so it survives
  // client-side sync and seeds future cold loads. The in-memory map (set
  // above) is the live read surface; this is its durable backing. Mirror the
  // request exactly — a chat moved out of a project clears it.
  {
    const pid = typeof projectId === "string" && projectId ? projectId : undefined;
    if (session.projectId !== pid) { session.projectId = pid; void ctx.saveSession(session); }
  }

  let doneEmitted = false;
  let lockHeld = false;
  // Set the instant installEventWiring's startChat registers this turn's
  // ActiveChat — via callback, so it's accurate even when the REST of the
  // wiring throws (onEventInstalled below only flips once wiring returns).
  // Holds the entry's own AbortController: the identity token the finally's
  // terminal net passes to failChatIfCurrent, so it can only ever terminate
  // THIS turn's entry (skeptic round 2 — a wedged turn's late error path must
  // not mark a successor's live entry done). Never set for turns that exited
  // before startChat (missing credential, lock refusal), where the only live
  // entry — if any — belongs to a DIFFERENT, still-running turn.
  let chatToken: AbortController | undefined;
  let onEventInstalled = false;
  let runtimeInstalled = false;
  let retryCtxAttached = false;

  const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Deliver a terminal failure to the client on whatever transport is live.
  // The WS chat UI runs with sseSink=null and only gets its per-turn onEvent
  // channel once installEventWiring runs — so a failure BEFORE that (missing
  // credential, routing, a prepare crash) has no live channel: emitSse is a
  // no-op and failChat can't terminate a chat startChat never registered. The
  // browser shows a spinner optimistically on send, so without a direct push it
  // spins forever. chatWs.emit → broadcastToSession reaches the session room
  // regardless of active-chat state, so route error+done there on the WS path.
  const emitTurnError = (msg: string) => {
    emitSse({ type: "error", message: msg });
    emitSse({ type: "done", usage: ZERO_USAGE } as ServerEvent);
    if (!sseSink) {
      ctx.chatWs.emit(sessionId, { type: "error", message: msg });
      ctx.chatWs.emit(sessionId, { type: "done", usage: ZERO_USAGE } as ServerEvent);
    }
    doneEmitted = true;
  };
  // One RetryContext per chat turn. Today only L1 (tool-executor's withRetry
  // for transient-network tools) reads it; the correlationId stitches its
  // log lines for this turn. See src/retry-context.ts for history.
  const retryCtx = createRetryContext();
  attachRetryContext(sessionId, retryCtx);
  retryCtxAttached = true;
  logger.info(`[retry] correlationId=${retryCtx.correlationId} sess=${sessionId.slice(0, 16)}`);
  const { tryAcquireOrReplace, releaseTurn: releaseTurnLock } = await import("../../../session/turn-lock.js");
  try {
    const prepared = await preparePerTurnRequest({
      sessionId, message, sessionMessages: session.messages, attachments, ctx,
      channel, bridgeContext: args.bridgeContext,
      skipMemory: args.skipMemory, maxHistory: args.maxHistory,
    });

    await emitContextStatus(prepared, ctx, sessionId, emitSse);

    if (!prepared.apiKey) {
      const label = prepared.provider === "xai" ? "Grok (xAI)" : prepared.provider;
      emitTurnError(`${label} isn't authenticated — the sign-in has expired or been revoked. Reconnect it in Settings → Providers, then resend.`);
      return;
    }

    const { routeMessage } = await import("../../../routing/index.js");
    message = await applyDiscussPrefix(message);

    // The redirect's ack + done must reach the client on whatever transport
    // is live — same dual-channel rule as emitTurnError above. WS clients
    // have no per-turn onEvent yet (startChat hasn't run), so route through
    // chatWs.emit → broadcastToSession; without it the browser's optimistic
    // turn spins forever (no opId → invisible to the stuck-stream watchdog).
    const emitRedirectAck = (event: ServerEvent) => {
      emitSse(event);
      if (!sseSink) ctx.chatWs.emit(sessionId, event);
    };
    if (await tryWorkerRedirect({
      sessionId, message, recentSessionMessages: session.messages, emit: emitRedirectAck,
      ingressKey: args.ingressKey,
    })) {
      doneEmitted = true;
      return;
    }

    const routeDecision = await routeMessage(prepared.provider, message, channel);
    if (routeDecision.destination === "delegate") {
      const handoff = await runDelegationHandoff({
        message, sessionId, prepared, ctx, session, requestRole, sseSink, ingressKey: args.ingressKey,
      });
      if (handoff.onEventInstalled) onEventInstalled = true;
      if (handoff.doneEmitted) doneEmitted = true;
      return;
    }

    const sessionTools = filterToolsForSession(prepared.tools, sessionId);

    // Acquire the turn lock BEFORE registering the chat. installEventWiring's
    // startChat does an unconditional activeChats.set(sessionId, ...); if it
    // ran first, a turn the lock is about to REFUSE would overwrite the still-
    // running turn's active-chat entry and then mark it done — the AGENTS badge
    // (broadcastActiveChats filters !done) would drop while the real turn kept
    // streaming, and Stop would hit chat.done===true and no-op, leaving the live
    // turn un-stoppable. So this controller is owned here and reaches startChat
    // only once the lock is granted. It's the one the agent loop's abortSignal
    // and the injection canary cancel, so a replace (registry.abortTurn) or a
    // canary trip actually stops the stream; user-Stop (terminateChat) aborts it
    // via the lock's abortTurn as well as the active-chat's own controller.
    const turnAbort = new AbortController();
    const decision = await tryAcquireOrReplace(sessionId, turnAbort, `chat:${prepared.provider}`);
    if (!decision.allowed) {
      const prev = decision.previous!;
      // Refused: a committing turn is already live. Surface the details on
      // whatever transport is live WITHOUT calling startChat, so the running
      // turn's active-chat entry (and its stoppability) is left untouched.
      emitTurnError(
        `Your previous request is still running (started ${Math.round(prev.elapsedMs / 1000)}s ago, ` +
        `iteration ${prev.iteration}, last action ${prev.lastToolName || "in progress"}). ` +
        `Cancel it first or wait for it to finish.`,
      );
      return;
    }
    lockHeld = true;
    if (decision.reason === "aborted-non-committing") {
      logger.info(`[turn-lock] aborted prior non-committing turn for sess=${sessionId} (was ${decision.previous?.elapsedMs}ms in, iter=${decision.previous?.iteration})`);
      // The prior turn just salvaged its committed work into session.messages
      // (tryAcquireOrReplace awaited its completion before returning). `prepared`
      // snapshotted history BEFORE that await — at line ~116, before the lock —
      // so refresh cleanHistory from the now-current session so THIS resume turn
      // sees what the interrupted turn did instead of re-deriving it. Closes the
      // same-instant "keep going" race; the common stop→read→resume path was
      // already covered by the salvage landing before the resume's prepare.
      try {
        const { buildCleanHistory } = await import("../../../providers/sanitize.js");
        prepared.cleanHistory = buildCleanHistory(
          session.messages as Parameters<typeof buildCleanHistory>[0],
          channel,
        );
      } catch (e) {
        logger.warn(`[turn-lock] cleanHistory refresh after replace failed: ${(e as Error).message}`);
      }
    }

    // Lock is held — now it's safe to register the chat (startChat) and stream.
    // Pass turnAbort so the stream signal and the injection canary cancel the
    // same controller the lock holds.
    const wiring = await installEventWiring({
      sessionId, message, attachments, prepared, ctx, emitSse, abortController: turnAbort,
      onChatRegistered: (token) => { chatToken = token; },
    });
    onEventInstalled = true;
    runtimeInstalled = true;

    const result = await runCanonicalChat({
      message, sessionId, prepared, sessionTools, session, ctx, requestRole,
      threatEngine: wiring.threatEngine,
      abortSignal: turnAbort.signal,
      primaryEventProxy: wiring.primaryEventProxy,
      wrappedOnEvent: wiring.wrappedOnEvent,
      emitSse,
      getFullResponseText: wiring.getFullResponseText,
    });
    if (result.doneEmitted) doneEmitted = true;
    return;
  } catch (e) {
    emitTurnError(safeErrorMessage(e));
  } finally {
    if (lockHeld) releaseTurnLock(sessionId);
    if (onEventInstalled) ctx.setActiveOnEvent(sessionId, undefined);
    if (runtimeInstalled) ctx.setActiveRuntime(sessionId, undefined);
    if (retryCtxAttached) detachRetryContext(sessionId);
    ctx.setActiveBrowserSessionId("default");
    try {
      const { clearSessionAllowedTools } = await import("../../../session/policy.js");
      clearSessionAllowedTools(sessionId);
    } catch {}
    if (!doneEmitted) {
      // Final safety net. Reach BOTH channels so neither an HTTP client
      // nor a WS subscriber is left hanging if we crashed before the
      // wrappedOnEvent path got to emit done.
      emitSse({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as ServerEvent);
      try { ctx.chatWs.failChat(sessionId, "Chat ended unexpectedly."); } catch {}
    } else if (chatToken) {
      // Orphaned-ActiveChat net (2026-07-13 audit skeptic finding). When a
      // throw lands AFTER startChat registered this turn's entry — e.g.
      // installEventWiring's augmentSystemPrompt, or runCanonicalChat — the
      // catch's emitTurnError terminates the turn via broadcast ONLY, never
      // through the entry's onEvent, so the entry's done flag stays false and
      // the !doneEmitted net above is skipped. The orphan then lives forever:
      // its replay buffer serves stale state to every future subscriber, the
      // next turn's startChat warns about overwriting it, and its heartbeat
      // interval spins indefinitely. failChatIfCurrent → terminateChat
      // (abort:false) buffers the terminal done into the replay buffer
      // (emitTurnError's done was broadcast-only) and marks the entry done;
      // empty errorMessage adds no error bubble beyond what emitTurnError
      // already sent, and the client's done handling is idempotent. No-op
      // when the turn already delivered done through onEvent. The token guard
      // (skeptic round 2) covers the wedge clobber: if this turn hung past
      // the 5s force-release and a successor's startChat overwrote the map
      // entry, a bare failChat here would mark the SUCCESSOR's live entry
      // done mid-stream — failChatIfCurrent refuses unless the entry is
      // still this turn's own.
      try { ctx.chatWs.failChatIfCurrent(sessionId, chatToken, ""); } catch {}
    }
  }
}
