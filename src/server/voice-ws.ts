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
import { VOICE_FAST_TOOLS, buildVoiceTail, voiceToolManifest } from "./voice-prompt.js";
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
async function planSpokenTurn(prepared: PreparedRequest, config: LAXConfig, allAgentTools: ToolDefinition[], sessionId: string) {
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

  // Voice has the SAME tools as text chat (full parity). The old "tools
  // mostly off" policy was a vestige of a weaker harness: it was meant to
  // stop a runaway tool-loop and a mid-conversation setting change, but the
  // op budget + wall-clock ceiling now bound runaway, and the tool-policy /
  // approval / rbac gates (all wired into this canonical run) enforce safety
  // identically in voice and text — so a request shouldn't behave
  // differently just because it was spoken. With no real tools the agent
  // FABRICATED actions it couldn't perform ("opened it"); parity fixes that.
  // The visuals toggle only governs the one cosmetic tool (voice_visual).
  const visualsEnabled = await voiceVisualsEnabled(config);
  // Governor: a voice turn is FAST and tool-light. It answers / does quick
  // lookups inline, drives the agent's OWN browser for web tasks, and
  // DELEGATES genuinely heavy/long work to a background worker
  // (op_submit_async) instead of grinding the full 169-tool agentic loop on
  // the voice critical path — which produced 13-22s silences and tool-parse
  // failures.
  //
  // `browser` drives the agent's own visible Chrome (its own persistent
  // profile, controllable over CDP) — so "open google" then "search it"
  // works as one flow, in a window the agent can actually act on. NOT the
  // user's real browser: open_url (OS launch → real browser) was removed
  // because the agent can't control what it opens there — a dead end. Nor
  // http_request on the belt (the model abused it to fake browser control via
  // invented localhost endpoints, then hallucinated success).
  // Mission scheduling is on the belt because it's a QUICK direct call,
  // and delegating it is impossible by design: scheduling is deliberately
  // excluded from the delegated-worker belt (mission_schedule_* is denied —
  // an unattended worker must not install recurring jobs), so a
  // "check/set up my 2am mission" spawn could never do it. It stays a
  // direct voice call.
  // Everything else is one tool_search away (it is on the belt): the tail
  // carries the index of what it can load, and a hit joins the op's tools
  // for the rest of this turn (canonical-loop/tool-augmentation.ts).
  // Voice belt + spoken-mode prompt tail (voice-prompt.ts).
  const voiceTools = allAgentTools.filter(t =>
    (VOICE_FAST_TOOLS as readonly string[]).includes(t.name) || (visualsEnabled && t.name === "voice_visual"));
  const voiceTail = buildVoiceTail(visualsEnabled) + voiceToolManifest(allAgentTools, voiceTools, sessionId);
  const { voiceSplit, voicePromptTelemetry } = voicePromptFor(prepared, voiceTail, voiceModel, voiceTools, allAgentTools.length);
  return { voiceModel, voiceTools, voiceSplit, voicePromptTelemetry };
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
        // Voice overrides tools (voiceTools) and the system prompt below, so
        // the intent classifier + memory-curate steps are pure waste on the
        // voice critical path. Lean prep skips them — keeps persona/memory.
        leanPrep: true,
      });

      if (!prepared.apiKey) {
        throw new Error(`No API key configured for ${prepared.provider}.`);
      }

      clock.mark("prepare");
      const { voiceModel, voiceTools, voiceSplit, voicePromptTelemetry } = await planSpokenTurn(prepared, config, allAgentTools, sessionId);
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
          tools: voiceTools,
          ...(prepared.images.length > 0 ? { images: prepared.images as AgentOptions["images"] } : {}),
          security, toolPolicy, rbac, threatEngine,
          sessionId,
          callContext: "local",
          // Budget: a quick lookup (web_search → speak) or delegate-and-ack
          // (op_submit_async → speak) needs ~2; a browser flow needs room for
          // navigate → observe → maybe one more action → speak. 8 covers an
          // open-and-act without inviting the deep agentic grind (genuinely long
          // work delegates to a worker, so a voice turn still stays shallow).
          maxIterations: 8,
          temperature: prepared.temperature,
          // Per provider (voice-model.ts): tight for a local runtime, room to
          // think for a hosted model. Explicit caps are never raised by the
          // local-window clamp, so a small window stays safe too.
          maxTokens: voiceMaxTokens(prepared.provider as ProviderId),
          // Anthropic text chat already uses direct HTTP OAuth for interactive
          // turns. Voice must do the same: the CLI warm-pool path is for
          // background agentic work and can sit silent while a subprocess
          // starts or wedges, leaving the user with no spoken response.
          preferAnthropicDirectHttp: true,
          // Thinking time is dead air in a spoken reply — the user sits in
          // silence while the model reasons about how to say two sentences.
          // This asks for the SHORT PATH declaratively; the client resolves
          // it into whatever lever the resolved model actually has
          // (planAnthropicReasoning). That conditionality is load-bearing:
          //   - On an effort-capable model (Opus 5 et al) it becomes adaptive
          //     thinking + output_config.effort "low". A voice turn SENDS
          //     TOOLS (voiceTools above), and Anthropic documents that with
          //     `thinking:{type:"disabled"}` Opus 5 "occasionally writes a
          //     tool call into its visible text instead of a tool_use block:
          //     the turn succeeds, the call never runs, no error is raised" —
          //     a tool call the user HEARS and that never executes. The
          //     documented fix is the opposite lever: "Turning thinking on and
          //     lowering effort fixes both and still cuts cost."
          //   - On a NON-ADAPTIVE model it becomes an omitted `thinking` param
          //     — the pre-existing behavior, and hazard-free there because
          //     those models have no adaptive mode to strand a call in text.
          //     This is the branch voice takes BY DEFAULT: resolveVoiceModel
          //     falls through to the provider's fast tier (anthropic →
          //     claude-haiku-4-5). The `voiceModel` setting ("chat", or an
          //     Opus id) puts voice on the adaptive branch, and its thinking
          //     counts against maxTokens above.
          // Sending an unconditional effort here instead would drop haiku into
          // the legacy budget_tokens arm.
          // The classifier lane (classify-with-llm.ts) keeps disableThinking:
          // it sends NO tools, so the hazard cannot bite there.
          // Genuinely heavy work still delegates to op_submit_async workers,
          // which keep their full effort budget.
          effort: "low",
          // Prompt-cache profile from the split above (see buildVoicePromptSplit).
          systemStablePrefixLen: voiceSplit.stableLen,
          cacheConversation: voiceSplit.fullyStable,
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
  } catch (e) { logger.warn("[voice-ws] setup failed:", (e as Error).message); }
}
