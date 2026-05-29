import type { ServerContext } from "../../../server-context.js";
import type { ServerEvent } from "../../../types.js";
import type { PreparedAgentRequest } from "../../../agent-request/types.js";
import { ThreatEngine } from "../../../threat/threat-engine.js";
import { DIRECTIVE_VERB_RE, type SseSink } from "./types.js";

export interface EventWiring {
  wsChat: ReturnType<ServerContext["chatWs"]["startChat"]>;
  threatEngine: ThreatEngine;
  /** Wrapped onEvent — runs canary check on `stream` deltas, then forwards. */
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
}

export async function installEventWiring(input: InstallEventWiringInput): Promise<EventWiring> {
  const { sessionId, message, attachments, prepared, ctx, emitSse } = input;

  const wsChat = ctx.chatWs.startChat(sessionId);
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

  const wrappedOnEvent = (event: ServerEvent) => {
    if (event.type === "stream" && "delta" in event && event.delta) {
      canaryBuffer += event.delta; fullResponseText += event.delta;
      if (canaryBuffer.length > 200) canaryBuffer = canaryBuffer.slice(-200);
      const canaryTrip = threatEngine.checkOutput(canaryBuffer) || (fullResponseText.length % 500 < 10 ? threatEngine.checkOutput(fullResponseText) : null);
      if (canaryTrip) { emitSse({ type: "error", message: "Security alert: prompt injection detected." }); wsChat.abort.abort(); return; }
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
