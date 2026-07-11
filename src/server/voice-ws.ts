import { type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/index.js";
import { getApprovalManager } from "../approval-manager.js";
import type { LAXConfig, ServerEvent, ToolDefinition, Session } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import type { RBACManager } from "../rbac.js";
import { createLogger } from "../logger.js";
const logger = createLogger("server.lifecycle");

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

    const voiceTurnRunner: import("../voice/voice-session/index.js").VoiceTurnRunner = async ({ text, signal, onDelta, onVisual, sessionId: voiceSessionId }) => {
      // Per-connection voice session id. The previous hardcoded "voice" caused
      // every concurrent voice connection to share global session-scoped state
      // (active onEvent callback, browser session, sub-agent inheritance).
      // Each voice WebSocket sends its own sessionId in the hello frame; here
      // we trust it so memory writes, retrieval, and tool plumbing isolate.
      const sessionId = voiceSessionId && voiceSessionId.trim() ? voiceSessionId : `voice-${randomUUID()}`;
      // Voice goes through the full agent pipeline so it knows the persona
      // (the main chat agent), has memory access, and can call tools. Earlier we routed
      // voice through a stripped-down LLM call to chase latency, but the
      // savings turned out to be marginal vs prompt caching, and the agent
      // appearing to forget who it was made the experience feel broken.
      //
      // The voice path differs from text chat in three ways:
      //   1. No threat engine / canary scanning (voice stream is short)
      //   2. No turn-lock / queue (voice has its own session-level concurrency)
      //   3. No fallback chain (voice picks the configured provider; an error
      //      surfaces as agent_error to the client which will retry)
      // Durable, continuous memory: load the persisted thread from the same
      // store text chat uses, rather than a per-connection in-memory history
      // that resets on every reconnect. The client sends the chat thread's own
      // id, so voice resumes after a drop AND continues what was typed.
      // flushSession first to read committed bytes, not a stale cache (the
      // store's documented read-after-write invariant).
      await flushSession(sessionId);
      const session = getOrCreateSession(sessionId);

      const prepared = await prepareAgentRequest({
        channel: "web",
        message: text,
        sessionMessages: session.messages,
        sessionId,
        config, dataDir,
        memoryIndex, memoryManager, integrations, secretsStore,
        allAgentTools, bridgeTools,
        // Voice overrides tools (voiceTools) and the system prompt below, so
        // the intent classifier + memory-curate steps are pure waste on the
        // voice critical path. Lean prep skips them — keeps persona/memory.
        leanPrep: true,
      });

      if (!prepared.apiKey) {
        throw new Error(`No API key configured for ${prepared.provider}.`);
      }

      // Voice has the SAME tools as text chat (full parity). The old "tools
      // mostly off" policy was a vestige of a weaker harness: it was meant to
      // stop a runaway tool-loop and a mid-conversation setting change, but the
      // op budget + wall-clock ceiling now bound runaway, and the tool-policy /
      // approval / rbac gates (all wired into this canonical run) enforce safety
      // identically in voice and text — so a request shouldn't behave
      // differently just because it was spoken. With no real tools the agent
      // FABRICATED actions it couldn't perform ("opened it"); parity fixes that.
      // The visuals toggle only governs the one cosmetic tool (voice_visual).
      let visualsEnabled = config.voice_visuals_enabled !== false;
      try {
        const { getSetting } = await import("../settings.js");
        const setting = getSetting<boolean>("voice_visuals_enabled");
        if (typeof setting === "boolean") {
          visualsEnabled = setting;
        }
      } catch { /* keep config-default */ }
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
      // because the agent can't control what it opens there — a dead end. NO
      // http_request either (the model abused it to fake browser control via
      // invented localhost endpoints, then hallucinated success).
      const VOICE_FAST_TOOLS = ["op_submit_async", "op_status", "web_search", "browser"];
      const voiceTools = allAgentTools.filter(t =>
        VOICE_FAST_TOOLS.includes(t.name) || (visualsEnabled && t.name === "voice_visual"));
      const visualPromptTail = visualsEnabled
        ? "\nThe sphere (voice_visual) is decoration, NOT your voice — never use it " +
          "instead of speaking. Use it RARELY for an emotional beat only (max " +
          "1/reply, 2.5s cooldown), e.g. voice_visual({kind:\"mood\", " +
          "value:\"excited\"}). Default to NO visual call."
        : "";
      const voiceSystemPrompt = prepared.systemPrompt +
        "\n\n## Voice mode\n" +
        "You're a fast, conversational voice assistant. The user HEARS your reply " +
        "(TTS) and only hears your spoken words — tool calls and the sphere are " +
        "silent. Keep every spoken line short and natural; no markdown, lists, " +
        "code, or emoji.\n" +
        "Route each request:\n" +
        "• A question you can answer, or a quick fact lookup: answer directly, or " +
        "use web_search inline, then say what you found in a sentence or two.\n" +
        "• Opening or using a website (\"open google\", \"pull up youtube\", \"search " +
        "X\", \"go to my email\"): use the browser tool. It opens and drives the " +
        "agent's OWN visible Chrome window — yours to control, so you can keep " +
        "going (\"open google\" then \"search it for X\" works). It is NOT the user's " +
        "everyday browser. Do the action, then say one short line about what you " +
        "see. Never claim you opened or did something the browser tool didn't " +
        "actually return.\n" +
        "• Genuinely heavy/long work (build an app, a big multi-site automation, " +
        "anything > ~30s): don't grind it on this turn. Call op_submit_async to " +
        "run it in the background, say one short line like \"On it — I'll let you " +
        "know when it's done,\" and STOP. Never narrate steps or claim it finished.\n" +
        "• When a background task you started has completed, its result is in your " +
        "context — open with it (\"That search came back — …\").\n" +
        "Never say you did something you didn't." + visualPromptTail;

      let assistantText = "";
      const onEvent = (event: ServerEvent) => {
        if (event.type === "stream" && "delta" in event && event.delta) {
          assistantText += event.delta;
          onDelta(event.delta);
        } else if (event.type === "visual" && onVisual) {
          // Forward the visual directive through to the voice WebSocket.
          onVisual(event.kind, event.value, event.durationMs);
        } else if (event.type === "approval_requested") {
          // Voice has no approval UI yet, and the approval timeout is 5 min —
          // letting it ride would hang the turn in silence. Decline immediately
          // so an approval-gated tool blocks cleanly; the prompt tells the agent
          // to say the action needs approval. This is the exact seam the verbal
          // "yes/no" approval renderer will replace (speak the prompt + capture
          // the spoken answer) instead of auto-declining.
          logger.info(`[voice-ws] auto-declining approval for ${event.toolName} (no voice approval UI yet)`);
          getApprovalManager().resolveApproval(event.approvalId, false);
        }
      };

      // Register this session's onEvent in the shared map so the MCP bridge
      // (Anthropic's tool path) can fire side-effect events that reach the
      // voice WebSocket. Codex calls voice_visual natively and uses the
      // _onEvent injection in tool-executor.ts, so this is only required
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
      // The aborted flag below reads stopReason OR signal.aborted so we
      // build the same "[interrupted by user]" history marker the legacy
      // throw-and-catch path produced.
      let aborted = false;
      try {
        const result = await runAgentViaCanonical(text, prepared.cleanHistory, {
          apiKey: prepared.apiKey,
          model: prepared.model,
          provider: prepared.provider as AgentOptions["provider"],
          baseURL: prepared.customBaseURL,
          systemPrompt: voiceSystemPrompt,
          tools: voiceTools,
          security, toolPolicy, rbac,
          sessionId,
          callContext: "local",
          // Budget: a quick lookup (web_search → speak) or delegate-and-ack
          // (op_submit_async → speak) needs ~2; a browser flow needs room for
          // navigate → observe → maybe one more action → speak. 8 covers an
          // open-and-act without inviting the deep agentic grind (genuinely long
          // work delegates to a worker, so a voice turn still stays shallow).
          maxIterations: 8,
          temperature: prepared.temperature,
          signal,
          onEvent,
          opType: "voice_turn",
          lane: "interactive",
        });
        if (signal.aborted || result.stopReason === "abort") aborted = true;
      } catch (e) {
        if (signal.aborted) {
          aborted = true;
        } else {
          throw e;
        }
      } finally {
        // Restore prior onEvent registration (if any) so we don't leak.
        if (hadPrev && prev) activeOnEventBySession.set(sessionId, prev);
        else activeOnEventBySession.delete(sessionId);
      }

      // Compose the assistant message that goes back into history. We do NOT
      // embed a tool-call trace: it used to be appended as a "[Tool calls this
      // turn: …]" marker so the model could self-reference, but persisting that
      // into history made the model echo the format back in its spoken reply
      // (even fabricating "[Tool calls this turn: none]"). Giving the model
      // tool self-knowledge belongs in structured tool_call round-tripping, not
      // a text marker the model reads and imitates.
      const interruptedMarker = aborted ? " [interrupted by user]" : "";
      const finalAssistantText = (assistantText + interruptedMarker).trim();

      // Commit this turn to the durable thread (same store + shape the
      // messaging bridges use). saveSession is queued and serialized per
      // session; the next turn flushSession's before reading it back.
      session.messages = [
        ...session.messages,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: finalAssistantText || "[no reply]" },
      ];
      session.updatedAt = Date.now();
      void saveSession(session);

      return { assistantText: finalAssistantText, updatedHistory: session.messages };
    };

    setVoiceSessionFactory(createVoiceSessionFactory(voiceTurnRunner, (name) => secretsStore.get(name) || ""));
  } catch (e) { logger.warn("[voice-ws] setup failed:", (e as Error).message); }
}
