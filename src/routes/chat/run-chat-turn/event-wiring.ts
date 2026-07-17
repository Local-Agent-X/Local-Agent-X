import type { ServerContext } from "../../../server-context.js";
import type { ServerEvent } from "../../../types.js";
import type { PreparedAgentRequest } from "../../../agent-request/types.js";
import { ThreatEngine } from "../../../threat/threat-engine.js";
import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "../../../providers/output-sanitize.js";
import { DIRECTIVE_VERB_RE, type SseSink } from "./types.js";

export interface EventWiring {
  wsChat: ReturnType<ServerContext["chatWs"]["startChat"]>;
  threatEngine: ThreatEngine;
  /** Wrapped onEvent — runs the canary check + delivery hygiene
   *  (output-sanitize.ts) on assistant stream text, then forwards. Every
   *  other event type passes through untouched. */
  wrappedOnEvent: (event: ServerEvent) => void;
  /**
   * Wrap onEvent so `done` events from the PRIMARY provider are swallowed
   * until we know whether we need a fallback. Otherwise the UI closes
   * the stream after the first provider's 'done' and misses any fallback.
   */
  primaryEventProxy: (event: ServerEvent) => void;
  /** Mutable accumulator for the agent's streamed assistant text. */
  getFullResponseText: () => string;
}

export interface InstallEventWiringInput {
  sessionId: string;
  message: string;
  attachments: Array<{ name: string; url: string; isImage: boolean }>;
  prepared: PreparedAgentRequest;
  ctx: ServerContext;
  emitSse: (ev: ServerEvent) => void;
  /**
   * The turn's abort controller — owned by the orchestrator and acquired into
   * the turn lock BEFORE this runs (so a refused turn never reaches startChat).
   * The canary trip below aborts THIS controller (the one the agent loop's
   * abortSignal is bound to), not startChat's internal one, so prompt-injection
   * detection actually cancels the live stream.
   */
  abortController: AbortController;
  /**
   * Fires synchronously the moment startChat registers this turn's ActiveChat
   * — BEFORE the rest of the wiring, which can still throw (augmentSystemPrompt
   * below). The orchestrator can't see a mid-wiring throw any other way: its
   * `onEventInstalled` flag only flips once this function RETURNS, so a throw
   * after startChat used to leave the registered entry invisible to every
   * cleanup path (2026-07-13 audit skeptic finding). `token` is the entry's
   * own AbortController (startChat's `.abort` return) — the orchestrator's
   * error path passes it to failChatIfCurrent so a wedged turn can only ever
   * terminate ITS entry, never a successor's that overwrote the sessionId
   * slot after a forced lock release (skeptic round 2).
   */
  onChatRegistered: (token: AbortController) => void;
}

export async function installEventWiring(input: InstallEventWiringInput): Promise<EventWiring> {
  const { sessionId, message, attachments, prepared, ctx, emitSse, abortController } = input;

  const wsChat = ctx.chatWs.startChat(sessionId);
  input.onChatRegistered(wsChat.abort);
  const onEvent = (event: ServerEvent) => { emitSse(event); wsChat.onEvent(event); };
  ctx.setActiveOnEvent(sessionId, onEvent);
  ctx.setActiveBrowserSessionId(sessionId);
  // Pin this turn's resolved provider+model so tools that spawn subprocesses
  // (build_app's CLI selection) honor the chat dropdown's active choice,
  // not whatever's stale in ~/.lax/settings.json.
  ctx.setActiveRuntime(sessionId, { provider: prepared.provider, model: prepared.model });

  const threatEngine = new ThreatEngine(ctx.dataDir, sessionId);
  // Threat-engine consent gating. Two paths can grant consent:
  //  1) Layer A — this turn's message has attachments + directive verbs
  //  2) Layer B — a prior turn granted consent via /approve, still in window
  // Either way we seed the per-turn analyzer so exfil patterns audit-but-
  // don't-block. Live failure 2026-05-13 (invoice PDF → Thrivemetrics)
  // motivates Layer A; the /approve flow handles cases Layer A misses.
  const { grantConsent, getActiveConsent } = await import("../../../threat/consent-store.js");
  if (attachments.length > 0 && DIRECTIVE_VERB_RE.test(message)) {
    grantConsent(sessionId, 30 * 60_000, `chat-attachment-with-directive (attachments=${attachments.length})`);
  }
  const activeConsent = getActiveConsent(sessionId);
  if (activeConsent) {
    threatEngine.markUserConsentFlow(activeConsent.remainingMs, activeConsent.reason);
  }
  const { augmentSystemPrompt } = await import("../system-prompt-augmentations.js");
  await augmentSystemPrompt(prepared, threatEngine, sessionId, message);

  let canaryBuffer = "";
  let fullResponseText = "";
  // Mirror of the CLIENT's visible answer text — the reducer's flat lane
  // (public/js/chat-stream-reducer.js `e.content`): forwarded deltas plus the
  // reducer's own edits (the "\n\n" break it inserts after tool events, the
  // "\n\nError: …" it appends on error events). The done intercept below runs
  // the full delivery pass over this mirror and emits a repair replace ONLY
  // when the pass changed something — so the mirror must be byte-exact, or
  // clean turns would pay a spurious replace (and the replace would clobber
  // the reducer's break/error bytes).
  let deliveredText = "";
  let deliveredToolsSinceText = false;

  const wrappedOnEvent = (event: ServerEvent) => {
    if (event.type === "stream" && "delta" in event && event.delta) {
      canaryBuffer += event.delta; fullResponseText += event.delta;
      if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
      const canaryTrip = threatEngine.checkOutput(canaryBuffer) || (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
      if (canaryTrip) { emitSse({ type: "error", message: "Security alert: prompt injection detected." }); abortController.abort(); return; }
      // Live answer deltas get ONLY the stateless special-token strip — the
      // full pass needs whole-document context (code spans, tag pairing) a
      // delta lacks. Whatever this misses (split tokens, reasoning tags,
      // hallucinated tool markup) the done intercept repairs on final text.
      // Reasoning-lane events are a different type and pass through below.
      const stripped = stripLeakedSpecialTokensStreaming(event.delta);
      // Junk-only delta: drop it. The pump never emits empty deltas, and
      // forwarding "" would let the reducer's tool-boundary rule insert a
      // paragraph break for text that doesn't exist.
      if (stripped.length === 0) return;
      if (deliveredToolsSinceText && deliveredText && !deliveredText.endsWith("\n")) deliveredText += "\n\n";
      deliveredText += stripped;
      deliveredToolsSinceText = false;
      onEvent(stripped === event.delta ? event : { ...event, delta: stripped });
      return;
    }
    if (event.type === "stream" && "replace" in event && event.replace === true) {
      // Adapter-initiated full-text replacement — rare and final-shaped, so
      // the full delivery pass is both affordable and safe here.
      const clean = sanitizeModelOutput(event.text, "delivery");
      deliveredText = clean;
      deliveredToolsSinceText = false;
      onEvent(clean === event.text ? event : { ...event, text: clean });
      return;
    }
    if (event.type === "tool_start" || event.type === "tool_end") {
      deliveredToolsSinceText = true;
    } else if (event.type === "error" && event.message) {
      const errText = `\n\nError: ${event.message}`;
      if (!deliveredText.endsWith(errText)) deliveredText += errText;
    } else if (event.type === "done") {
      // Turn end. The client renders the ACCUMULATED deltas — there is no
      // final full-text event (`done` carries only usage; the reducer just
      // flips status) — so this is where the final text gets the full
      // delivery pass. When it differs from what streamed, emit ONE repair
      // replace (the reducer swaps the bubble text) before done; clean turns
      // hit the identity fast path and cost nothing extra.
      const finalText = sanitizeModelOutput(deliveredText, "delivery");
      if (finalText !== deliveredText) {
        deliveredText = finalText;
        onEvent({ type: "stream", replace: true, text: finalText });
      }
    }
    onEvent(event);
  };

  const primaryEventProxy = (event: ServerEvent) => {
    if (event.type === "done") return; // defer — we'll emit after fallback decision
    wrappedOnEvent(event);
  };

  return {
    wsChat,
    threatEngine,
    wrappedOnEvent,
    primaryEventProxy,
    getFullResponseText: () => fullResponseText,
  };
}
