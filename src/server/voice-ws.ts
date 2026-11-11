import { type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/index.js";
import { createSpokenApprovals } from "./voice-spoken-approval.js";
import type { LAXConfig, ServerEvent, ToolDefinition, Session } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { RBACManager } from "../rbac.js";
import { createLogger } from "../logger.js";
import { VoiceTurnHygiene } from "./voice-turn-hygiene.js";
import { warmModel } from "../local-runtimes/residency.js";
import { createPromptTelemetry } from "../prompt-telemetry.js";
import { buildVoicePromptSplit } from "./voice-prompt-plan.js";
import { retractLastTurn } from "../memory/retract-last-turn.js";
import { resolveVoiceModel, voiceMaxTokens } from "./voice-model.js";
import { buildVoiceTail } from "./voice-prompt.js";
import { spokenTurnAbility } from "./spoken-turn-options.js";
import type { ProviderId } from "../providers/provider-ids.js";
import { userAuthoredRows } from "../harness-rows.js";
import { withRecallCarried } from "../agent-request/recall-carry.js";
import { withCompletionsCarried } from "../agent-request/completion-carry.js";
import { OP_TYPE } from "../ops/op-types.js";
import { ThreatEngine } from "../threat/threat-engine.js";
import type { VoiceTurnInput, VoiceTurnRunner } from "../voice/voice-session/index.js";
import { VOICE_BUSY_REPLY, canaryWatch, carriedToolRows, carriedHarnessRows, claimVoiceTurn, isCardMetadata, commitVoiceTurn, spokenUserRow, voiceTurnRows, type VoiceTurnSlot } from "./voice-turn-guard.js";
import { createVoiceTurnClock, type VoiceTurnClock } from "./voice-turn-timing.js";
const logger = createLogger("server.lifecycle");

/**
 * The spoken turn's system prompt and its telemetry. Prompt-cache split: static
 * sections + voice tail form the stable prefix; per-turn dynamic sections
 * (memory retrieval, notices) move after it. stream-api caches the stable
 * block, so consecutive spoken turns stop re-prefilling the whole system tier.
 * When a turn has no dynamic sections at all, history-tier caching engages too.
 */
function voicePromptFor(
  prepared: Awaited<ReturnType<typeof import("../agent-request/index.js").prepareAgentRequest>>,
  voiceTail: string,
  voiceModel: string,
  voiceTools: ToolDefinition[],
  allToolCount: number,
) {
  const voiceSplit = buildVoicePromptSplit(prepared.renderedPromptSections, prepared.systemPrompt, voiceTail);
  const voicePromptTelemetry = createPromptTelemetry({
    profile: "voice",
    provider: prepared.provider,
    model: voiceModel,
    toolSchemaFormat: prepared.promptTelemetry.toolSchemaFormat,
    prompt: voiceSplit.systemPrompt,
    tools: voiceTools,
    allToolCount,
    historyMessageCount: prepared.cleanHistory.length,
    sections: voiceSplit.sections.map((section) => section.measurement),
  });
  return { voiceSplit, voicePromptTelemetry };
}

/** The voice_visual toggle: settings.json first, then config. */
async function voiceVisualsEnabled(config: LAXConfig): Promise<boolean> {
  try {
    const { getSetting } = await import("../settings.js");
    const setting = getSetting<boolean>("voice_visuals_enabled");
    if (typeof setting === "boolean") return setting;
  } catch { /* settings unreadable: the config default below stands */ }
  return config.voice_visuals_enabled !== false;
}

type PreparedRequest = Awaited<ReturnType<typeof import("../agent-request/index.js").prepareAgentRequest>>;

/** The spoken turn's model, tool belt and prompt, chosen from the prepared request. */
async function planSpokenTurn(prepared: PreparedRequest, config: LAXConfig, allAgentTools: ToolDefinition[]) {
  // Spoken-turn model: the selected provider's FAST tier, not the chat
  // model. A reasoning chat model (gpt-5.6-sol) thinks 13-16s before
  // speaking — dead air. resolveVoiceModel swaps in the provider's declared
  // fast model (codex → gpt-5.4-mini, etc.) while keeping the provider;
  // heavy work still delegates to full-power workers on the chat model.
  const { getSetting } = await import("../settings.js");
  const voiceModel = resolveVoiceModel(prepared.provider as ProviderId, prepared.model, getSetting);
  if (voiceModel !== prepared.model) {
    logger.info(`[voice-ws] spoken turn on fast tier: ${prepared.provider}/${voiceModel} (chat model ${prepared.model})`);
  }

  // Keep a local voice model resident across the conversation: fire-and-
  // forget warm (deduped, 30m keep-alive) so turns after the first don't
  // pay a cold load, and the current turn's own request keeps it warm. The
  // very first turn of a cold session can still load-wait; a connect-time
  // prewarm is a follow-up. No-op / harmless 404 for non-Ollama runtimes.
  // Passing no size is deliberate: warmModel loads at the context the
  // turn's own request applies (context-sizing.ts), so the warm never
  // reloads the model this turn is about to use.
  if (prepared.provider === "local") warmModel(config.ollamaUrl, voiceModel);

  // The turn's tools and settings are the typed turn's (spoken-turn-options.ts);
  // the prepared prompt already carries the index of every tool not loaded,
  // for tool_search. Voice adds only how it talks (voice-prompt.ts).
  const visualsEnabled = await voiceVisualsEnabled(config);
  const ability = spokenTurnAbility(prepared, visualsEnabled);
  const voiceTail = buildVoiceTail(visualsEnabled);
  const { voiceSplit, voicePromptTelemetry } = voicePromptFor(prepared, voiceTail, voiceModel, ability.tools, allAgentTools.length);
  return { voiceModel, ability, voiceSplit, voicePromptTelemetry };
}

/** Continuation merge (turn-runner armed it): the turn's text re-includes the
 *  barged-over utterance, so retract the interrupted turn's rows — via the
 *  canonical retractLastTurn, never a hand-splice — so the merged turn
 *  REPLACES them. Guarded on the tail actually being that turn: if any other
 *  writer slipped a row in, keep history intact (mild duplication beats
 *  deleting someone else's turn). */
function retractContinuedTurn(session: Session, continuationOf: string): void {
  const lastUser = [...userAuthoredRows(session.messages)].reverse().find((m) => m.role === "user");
  if (!lastUser || typeof lastUser.content !== "string" || lastUser.content !== continuationOf) return;
  const retracted = retractLastTurn(session.messages, { includeUser: true });
  if (retracted.removed > 0) session.messages = retracted.messages;
}

export async function setupVoiceWs(deps: {
  server: Server;
  config: LAXConfig;
  dataDir: string;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  integrations: IntegrationRegistry;
  secretsStore: SecretsStore;
  allAgentTools: ToolDefinition[];
  bridgeTools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
  /** Shared registry mapping sessionId → onEvent sink. Anthropic routes
   *  tool calls through the MCP bridge (`/api/mcp/call`), which looks up
   *  the session's onEvent here to fire side-effect events. Without
   *  registering the voice session's sink, voice_visual's emits get
   *  dropped on Anthropic (they work on Codex which calls natively). */
  activeOnEventBySession: Map<string, (event: ServerEvent) => void>;
  /** Same session store text chat uses — voice persists/loads its transcript
   *  here so a conversation survives reconnects and continues across modalities
   *  (the client sends the chat thread's own id). */
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => Promise<void>;
  flushSession: (id: string) => Promise<void>;
}): Promise<void> {
  const {
    server, config, dataDir, memoryIndex, memoryManager, integrations,
    secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac,
    activeOnEventBySession, getOrCreateSession, saveSession, flushSession,
  } = deps;
  try {
    const { setupVoiceWebSocket, setVoiceSessionFactory } = await import("../voice/audio-ws.js");
    const { createVoiceSessionFactory } = await import("../voice/voice-session/index.js");
    const { prepareAgentRequest } = await import("../agent-request/index.js");
    setupVoiceWebSocket(server, config.authToken, config.maxUploadBytes);

    // Voice goes through the full agent pipeline so it knows the persona
    // (the main chat agent), has memory access, and can call tools. Earlier we routed
    // voice through a stripped-down LLM call to chase latency, but the
    // savings turned out to be marginal vs prompt caching, and the agent
    // appearing to forget who it was made the experience feel broken.
    //
    // It shares the typed turn's safety on the same thread (voice-turn-guard.ts):
    // the session's turn slot, the stale-writer check, an append-only save, the
    // end-of-turn memory pass, and the threat engine with its canary watch. It
    // differs in having no fallback chain (voice picks the configured provider;
    // an error surfaces as agent_error to the client, which will retry).
    const runVoiceTurn = async ({ text, attachments, continuationOf, device, onDelta, onVisual, onCard, awaitAnswer }: VoiceTurnInput, sessionId: string, slot: VoiceTurnSlot, clock: VoiceTurnClock) => {
      // Durable, continuous memory: load the persisted thread from the same
      // store text chat uses, rather than a per-connection in-memory history
      // that resets on every reconnect. The client sends the chat thread's own
      // id, so voice resumes after a drop AND continues what was typed.
      // flushSession first to read committed bytes, not a stale cache (the
      // store's documented read-after-write invariant).
      await flushSession(sessionId);
      const session = getOrCreateSession(sessionId);
      clock.mark("load");

      if (continuationOf) retractContinuedTurn(session, continuationOf);

      const prepared = await prepareAgentRequest({
        channel: "voice",
        voiceDevice: device,
        message: text,
        continuationOf,
        sessionMessages: session.messages,
        sessionId,
        config, dataDir,
        memoryIndex, memoryManager, integrations, secretsStore,
        allAgentTools, bridgeTools,
        // What the user showed the agent on the call (a photo, a file, the camera's
        // frame): the chat's attachment path, so an image is saved under uploads,
        // shown to the model, and kept on the user's row like a typed one.
        attachments: attachments?.map((a) => ({ isImage: a.isImage, name: a.name, url: a.dataUrl, ...(a.glance ? { glance: a.glance } : {}) })),
        uploadsDir: join(dataDir, "uploads"),
        // No model call before the turn's own (memory relevance by keyword):
        // each was seconds of silence. Tools and prompt are a typed turn's.
        leanPrep: true,
      });

      if (!prepared.apiKey) {
        throw new Error(`No API key configured for ${prepared.provider}.`);
      }

      clock.mark("prepare");
      const { voiceModel, ability, voiceSplit, voicePromptTelemetry } = await planSpokenTurn(prepared, config, allAgentTools);
      clock.mark("plan");
      const voiceSystemPrompt = voiceSplit.systemPrompt;
      const voiceRenderedPromptSections = voiceSplit.sections;

      // TTS + transcript hygiene: strips leaked template tokens from each
      // spoken delta and runs the full pass on the stored text (see the class).
      const hygiene = new VoiceTurnHygiene();
      const threatEngine = new ThreatEngine(dataDir, sessionId);
      const canaryTripped = canaryWatch(threatEngine, slot.abort);
      const approvals = createSpokenApprovals({ speak: (line) => onDelta(hygiene.said(line)), awaitAnswer, turnSignal: slot.signal, log: (line) => logger.info(line) });
      const onEvent = (event: ServerEvent) => {
        if (event.type === "stream" && "delta" in event && event.delta) {
          clock.firstToken();
          if (canaryTripped(event.delta)) return;
          const spoken = hygiene.delta(event.delta);
          if (spoken !== null) onDelta(spoken);
        } else if (event.type === "tool_start") {
          const line = hygiene.lookupStarted(event.toolName, (event.args ?? {}) as Record<string, unknown>);
          if (line) onDelta(line);
        } else if (event.type === "visual" && onVisual) {
          // Forward the visual directive through to the voice WebSocket.
          onVisual(event.kind, event.value, event.durationMs);
        } else if (event.type === "tool_end" && onCard && isCardMetadata(event.metadata)) {
          // A card the agent showed: drawn in the chat as the reply is spoken.
          onCard(event.metadata.card);
        } else if (event.type === "stopped" && event.firedBy === "stream-guard") {
          // The degenerate-output guard tore a looping stream down mid-reply.
          // Voice has no card surface, so speak a short honest notice instead
          // of ending in abrupt silence. Never fires on user barge-in — that
          // path sets `aborted` via the abort signal, not this event.
          logger.info(`[voice-ws] stream guard stopped a degenerate reply (${sessionId}); spoke a notice`);
          onDelta(hygiene.guardStopped());
        } else if (event.type === "approval_requested") {
          // Asked out loud; the user's next words answer it (voice-spoken-approval.ts).
          approvals.requested(event);
        } else if (event.type === "approval_resolved" || event.type === "approval_timeout") {
          // Answered on a card or timed out: stop waiting for a spoken answer.
          approvals.settled(event.approvalId);
        }
      };

      // Register this session's onEvent in the shared map so the MCP bridge
      // (Anthropic's tool path) can fire side-effect events that reach the
      // voice WebSocket. Codex calls voice_visual natively and uses the
      // _onEvent injection in tool-execution/, so this is only required
      // for Anthropic, but registering unconditionally is harmless.
      const hadPrev = activeOnEventBySession.has(sessionId);
      const prev = activeOnEventBySession.get(sessionId);
      activeOnEventBySession.set(sessionId, onEvent);
      // Track whether the turn aborted so we can build a sensible history
      // entry instead of dropping the partial reply. AbortError from the
      // signal triggers if the user barges in or stops mid-reply; without
      // catching it here, voice-session's catch swallows the whole turn
      // and the model has no record of what it just said.
      // Canonical-loop path (P4.C5): voice turn now shares chat's safety
      // stack + cancel machinery. tools=[] (or [voice_visual]) + maxIter=1-2
      // means the iteration-loop middlewares short-circuit; observable agent
      // behavior matches the legacy 1-shot voice path.
      //
      // Barge-in: the existing AbortController signal flows in as
      // options.signal. agent-runner wires it to opCancel — canonical
      // transitions running → cancelling → cancelled cleanly and the
      // returned AgentTurn carries stopReason="abort" instead of throwing.
      // The aborted flag below reads stopReason OR signal.aborted so the
      // stored assistant row carries the same `_interrupted` record the
      // legacy throw-and-catch path produced (as an inline marker, then).
      let aborted = false;
      let turnOpId: string | undefined;
      let carried: ReturnType<typeof carriedHarnessRows> = [];
      try {
        const result = await runAgentViaCanonical(text, prepared.cleanHistory, {
          apiKey: prepared.apiKey,
          model: voiceModel,
          provider: prepared.provider as AgentOptions["provider"],
          baseURL: prepared.customBaseURL,
          systemPrompt: voiceSystemPrompt,
          // What the turn can do is the typed turn's: its tools, steps, sampling,
          // reasoning, first-tool pin and no forced opening tool call
          // (spoken-turn-options.ts). Voice has no effort of its own: "low" made
          // a spoken turn search once and give up where a typed one kept looking
          // (2026-11-11).
          ...ability,
          ...(prepared.images.length > 0 ? { images: prepared.images as AgentOptions["images"] } : {}),
          security, toolPolicy, rbac, threatEngine,
          sessionId,
          callContext: "local",
          // A local runtime keeps a tight cap, where a degenerate model can
          // loop; a hosted one has none, as a typed turn has none (voice-model.ts).
          maxTokens: voiceMaxTokens(prepared.provider as ProviderId),
          // Anthropic text chat already uses direct HTTP OAuth for interactive
          // turns. Voice must do the same: the CLI warm-pool path is for
          // background agentic work and can sit silent while a subprocess
          // starts or wedges, leaving the user with no spoken response.
          preferAnthropicDirectHttp: true,
          // Prompt-cache profile from the split above (see buildVoicePromptSplit).
          // The per-turn sections go at the end of the conversation, not in front
          // of it, so the thread so far is read from cache (cache-breakpoints.ts
          // withSystemTail). Without a split point the prompt is one block that
          // changes every turn, and a breakpoint under it would only ever write.
          systemStablePrefixLen: voiceSplit.stableLen,
          systemTailInMessages: true,
          cacheConversation: voiceSplit.fullyStable || voiceSplit.stableLen !== undefined,
          signal: slot.signal,
          onEvent,
          opType: OP_TYPE.voiceTurn,
          lane: "interactive",
          promptTelemetry: voicePromptTelemetry,
          renderedPromptSections: voiceRenderedPromptSections,
          savedToChat: true,
        });
        turnOpId = result.opId;
        carried = [
          ...carriedHarnessRows(result.messages, prepared.cleanHistory.length),
          ...carriedToolRows(result.messages, prepared.cleanHistory.length),
        ];
        if (slot.signal.aborted || result.stopReason === "abort") aborted = true;
      } catch (e) {
        if (slot.signal.aborted) {
          aborted = true;
        } else {
          throw e;
        }
      } finally {
        // Restore prior onEvent registration (if any) so we don't leak.
        if (hadPrev && prev) activeOnEventBySession.set(sessionId, prev);
        else activeOnEventBySession.delete(sessionId);
      }
      logger.info(clock.line(sessionId, `${prepared.provider}/${voiceModel}`));

      // Compose the assistant message that goes back into history. Control-
      // plane facts (interrupted, tool traces) must NOT be embedded as inline
      // text: a "[Tool calls this turn: …]" marker used to be appended here
      // and the model echoed the format back in its spoken reply; the
      // " [interrupted by user]" marker that replaced it got echoed 763 times
      // in one Grok reply. The interruption travels as `_interrupted: true`
      // (structural, like `_ephemeral`) and providers/sanitize.ts renders it
      // for the model at the one seam all provider-bound history crosses.
      // Persist-profile hygiene over the full turn text (leaked tokens,
      // reasoning tags, hallucinated tool markup, whole-reply repeats) before
      // it enters the durable thread — the streaming strip above only cleaned
      // what TTS spoke. The `_interrupted` record stays structural below.
      const finalAssistantText = hygiene.finalize();

      // Commit this turn to the durable thread (same store + shape the
      // messaging bridges use). saveSession is queued and serialized per
      // session; the next turn flushSession's before reading it back.
      const assistantRow = {
        role: "assistant" as const,
        content: finalAssistantText || "[no reply]",
        ...(aborted ? { _interrupted: true } : {}),
      };
      await commitVoiceTurn({
        session, sessionId, turnSignal: slot.signal, userText: text, replyText: finalAssistantText,
        rows: withCompletionsCarried(withRecallCarried([spokenUserRow(text, prepared.images), ...carried, assistantRow], prepared.recall), prepared.backgroundCompletions),
        turnMessages: await voiceTurnRows(turnOpId),
        memoryManager, saveSession,
      });

      return { assistantText: finalAssistantText, updatedHistory: session.messages };
    };

    const voiceTurnRunner: VoiceTurnRunner = async (input) => {
      // Per-connection voice session id. The previous hardcoded "voice" caused
      // every concurrent voice connection to share global session-scoped state
      // (active onEvent callback, browser session, sub-agent inheritance).
      // Each voice WebSocket sends its own sessionId in the hello frame; here
      // we trust it so memory writes, retrieval, and tool plumbing isolate.
      const sessionId = input.sessionId && input.sessionId.trim() ? input.sessionId : `voice-${randomUUID()}`;
      // Claimed before the thread is read: a replaced turn (barge-in, or a
      // typed message) has saved its rows by the time this one loads them.
      const clock = createVoiceTurnClock();
      const slot = await claimVoiceTurn(sessionId, input.signal);
      clock.mark("slot");
      if (!slot) {
        input.onDelta(VOICE_BUSY_REPLY);
        return { assistantText: VOICE_BUSY_REPLY, updatedHistory: getOrCreateSession(sessionId).messages };
      }
      try {
        return await runVoiceTurn(input, sessionId, slot, clock);
      } finally {
        slot.release();
      }
    };

    setVoiceSessionFactory(createVoiceSessionFactory(voiceTurnRunner, (name) => secretsStore.get(name) || ""));

    // A camera watch whose call ended says so in the call's chat thread, since nothing
    // can be said then (voice-session/camera-watch.ts).
    const { setCameraWatchNoter } = await import("../voice/voice-session/camera-watch.js");
    setCameraWatchNoter((sessionId, text) => {
      const session = getOrCreateSession(sessionId);
      session.messages.push({ role: "assistant", content: text });
      session.updatedAt = Date.now();
      void saveSession(session);
    });
  } catch (e) { logger.warn("[voice-ws] setup failed:", (e as Error).message); }
}
