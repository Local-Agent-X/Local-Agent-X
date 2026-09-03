import type { ServerEvent } from "../../../types.js";
import { safeErrorMessage } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { runDelegationHandoff } from "../delegation-handoff.js";
import { createRetryContext, attachRetryContext, detachRetryContext } from "../../../retry-context.js";
import type { RunChatTurnArgs } from "./types.js";
import { handleApproveCommand, expandSlash } from "./slash-interceptors.js";
import {
  preparePerTurnRequest, emitContextStatus,
  filterToolsForSession, applyDiscussPrefix,
} from "./prepare-and-route.js";
import { installEventWiring } from "./event-wiring.js";
import { runCanonicalChat } from "./canonical-run.js";
import { PROVIDERS } from "../../../providers/registry.js";
import { PROVIDER_IDS, type ProviderId } from "../../../providers/provider-ids.js";
import type { ChannelKind } from "../../../agent-request/types.js";

const logger = createLogger("routes.chat.run-turn");

/** Display name for a provider id in user-facing turn errors. The registry is
 *  the single source of truth for provider metadata, so the name in the error
 *  is the name the Settings picker shows — no second copy to drift, and no raw
 *  ids ("gemini isn't authenticated") reaching a chat bubble. `prepared.provider`
 *  is a plain string on the wire, so an unrecognized id degrades to itself. */
const providerLabel = (id: string): string =>
  ((PROVIDER_IDS as readonly string[]).includes(id) ? PROVIDERS[id as ProviderId].label : id);

/** Where to go to fix a credential, phrased for where the user actually is.
 *  The web chat IS the app, so Settings → Providers is one click away; this
 *  same turn path serves the Telegram/WhatsApp bridges
 *  (src/server/inbound-channel-runner.ts), whose users are on a phone and
 *  cannot reach that screen from the message they're reading. The POLICY is
 *  identical on every channel — an answer from a model the user didn't pick is
 *  no better over Telegram — only the remedy differs. */
const reconnectHint = (channel: ChannelKind, label: string): string =>
  (channel === "web"
    ? `Reconnect ${label} in Settings → Providers, then resend.`
    : `Reconnect ${label} on the computer running Local Agent X (Settings → Providers), then resend.`);

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
  // Push one event on whatever transport is live — the same dual-channel rule
  // emitTurnError follows, for everything emitted BEFORE installEventWiring
  // gives WS clients their per-turn onEvent channel. chatWs.emit →
  // broadcastToSession reaches the session room regardless of active-chat
  // state; without it a WS client sees nothing at all this early in the turn.
  const emitLive = (event: ServerEvent) => {
    emitSse(event);
    if (!sseSink) ctx.chatWs.emit(sessionId, event);
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

    // A reroute off an EXPLICITLY selected provider is a lie the client cannot
    // detect on its own: the fallback chain hands back a WORKING key for a
    // DIFFERENT provider, so the isn't-authenticated gate below — which reads
    // the POST-reroute provider — passes, and the turn runs on a model the
    // composer never showed (the live incident: chip on grok-4.5, turn on
    // claude-opus-5). On this interactive path that fails the turn instead:
    // the user picked the provider, so a dead credential is theirs to fix, not
    // ours to paper over. This is only safe because the resolver no longer
    // reports a switch on the sync `hasCredential()` probe's word alone — it
    // re-asks resolveCredential about the requested provider first, so a
    // `credential-unavailable` switch means genuinely unusable, not merely
    // undetectable (see agent-request/resolve-provider.ts). Background/internal
    // callers (cron, workers, classifiers) never come through here and keep
    // rerouting with the resolver's warn line; the messaging bridges DO come
    // through here and get the same policy with a remedy they can reach
    // (reconnectHint). A `local-only` switch is NOT a failure — the user
    // configured strict local mode, so its reroute is the requested behavior
    // and only needs announcing (below).
    const providerSwitch = prepared.providerSwitch;
    if (providerSwitch?.reason === "credential-unavailable") {
      const requested = providerLabel(providerSwitch.from);
      emitTurnError(
        `${requested} isn't authenticated — the sign-in has expired or been revoked. ` +
        `This turn was NOT rerouted to ${providerLabel(providerSwitch.to)}. ` +
        `${reconnectHint(channel, requested)} (Or pick another provider.)`,
      );
      return;
    }

    if (!prepared.apiKey) {
      const active = providerLabel(prepared.provider);
      emitTurnError(`${active} isn't authenticated — the sign-in has expired or been revoked. ${reconnectHint(channel, active)}`);
      return;
    }

    // Tell the client which provider+model this turn is ACTUALLY running on.
    // Announced at each point where the turn is COMMITTED to a model turn on
    // exactly these values — never earlier. A turn the lock REFUSES runs
    // nothing, so announcing before that check describes a turn that never
    // happens. Worst case is
    // the exact bug class this event exists to kill: turn A is streaming on
    // grok, the user switches to Anthropic and sends B, the lock refuses B —
    // and B's announcement repaints the chip to Anthropic while A is still
    // streaming on grok. Deliberately NOT settings_changed: that writes
    // localStorage in every tab and would persist a transient reroute as if the
    // user had chosen it. This describes one turn's execution, never a
    // preference.
    const announceProvider = () => emitLive({
      type: "turn_provider",
      provider: prepared.provider,
      model: prepared.model,
      rerouted: !!providerSwitch,
      requestedProvider: providerSwitch?.from,
      // Derived from the discriminator, not assumed: `credential-unavailable`
      // already failed the turn above, so local-only is the only reason that
      // reaches this line today.
      reason: providerSwitch?.reason === "local-only" ? "strict local-only mode" : undefined,
    });

    const { routeMessage } = await import("../../../routing/index.js");
    message = await applyDiscussPrefix(message);

    const routeDecision = await routeMessage(prepared.provider, message, channel);
    if (routeDecision.destination === "delegate") {
      // The ack turn really does run on prepared.provider/model
      // (delegation-handoff.ts → runAgentViaCanonical with prepared's key,
      // provider and model), so this turn is committed and announces. It
      // returns before the turn lock, which is why the announcement can't
      // simply live after the lock for every path.
      announceProvider();
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
    // Committed: the lock is ours and the model turn below is going to run.
    announceProvider();
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
