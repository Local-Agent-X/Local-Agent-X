import { type Server } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentOptions } from "../providers/types.js";
import { runAgentViaCanonical } from "../canonical-loop/agent-runner.js";
import type { LAXConfig, ServerEvent, ToolDefinition } from "../types.js";
import type { MemoryIndex, MemoryManager } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { IntegrationRegistry } from "../integrations/index.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy.js";
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
}): Promise<void> {
  const {
    server, config, dataDir, memoryIndex, memoryManager, integrations,
    secretsStore, allAgentTools, bridgeTools, security, toolPolicy, rbac,
    activeOnEventBySession,
  } = deps;
  try {
    const { setupVoiceWebSocket, setVoiceSessionFactory } = await import("../voice/audio-ws.js");
    const { createVoiceSessionFactory } = await import("../voice/voice-session/index.js");
    const { prepareAgentRequest } = await import("../agent-request/index.js");
    setupVoiceWebSocket(server, config.authToken);

    const voiceTurnRunner: import("../voice/voice-session/index.js").VoiceTurnRunner = async ({ text, history, signal, onDelta, onVisual, sessionId: voiceSessionId }) => {
      // Per-connection voice session id. The previous hardcoded "voice" caused
      // every concurrent voice connection to share global session-scoped state
      // (active onEvent callback, browser session, sub-agent inheritance).
      // Each voice WebSocket sends its own sessionId in the hello frame; here
      // we trust it so memory writes, retrieval, and tool plumbing isolate.
      const sessionId = voiceSessionId && voiceSessionId.trim() ? voiceSessionId : `voice-${randomUUID()}`;
      // Voice goes through the full agent pipeline so it knows the persona
      // (Primal), has memory access, and can call tools. Earlier we routed
      // voice through a stripped-down LLM call to chase latency, but the
      // savings turned out to be marginal vs prompt caching, and the agent
      // appearing to forget who it was made the experience feel broken.
      //
      // The voice path differs from text chat in three ways:
      //   1. No threat engine / canary scanning (voice stream is short)
      //   2. No turn-lock / queue (voice has its own session-level concurrency)
      //   3. No fallback chain (voice picks the configured provider; an error
      //      surfaces as agent_error to the client which will retry)
      const sessionMessages = history.map(m => ({
        role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user") as "user" | "assistant" | "system",
        content: typeof m.content === "string" ? m.content : "",
      }));

      const prepared = await prepareAgentRequest({
        channel: "web",
        message: text,
        sessionMessages,
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

      // Voice-mode policy: persona + memory yes, tools mostly NO. The agent
      // in text chat has dozens of tools (http_request, browser_*, settings,
      // etc.) and eagerly uses them — but in voice that produced a turn that
      // changed the user's voice setting mid-conversation, then went into a
      // 40k-token tool-exploration loop before aborting. Voice is a
      // conversation, not an action surface.
      //
      // Exception: when voice_visuals_enabled is on (default), we expose
      // ONE tightly-scoped tool — voice_visual — that lets the agent morph
      // the on-screen particle sphere into emojis/text/shapes/moods when
      // something is emotionally significant. The tool is rate-limited
      // server-side (1 call/turn + 2.5s cooldown) so it can't be abused.
      // Read the live toggle from settings.json so a flip in the UI takes
      // effect on the next voice turn — no restart required.
      let visualsEnabled = config.voice_visuals_enabled !== false;
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const settingsPath = join(dataDir, "settings.json");
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (typeof s.voice_visuals_enabled === "boolean") {
            visualsEnabled = s.voice_visuals_enabled;
          }
        }
      } catch { /* keep config-default */ }
      let voiceTools: ToolDefinition[] = [];
      if (visualsEnabled) {
        const tool = allAgentTools.find(t => t.name === "voice_visual");
        if (tool) voiceTools = [tool];
      }
      const visualPromptTail = visualsEnabled
        ? "\nYou have one tool: voice_visual(kind, value). Use it RARELY — " +
          "only when something is emotionally significant. Most replies have " +
          "no tool call. The system enforces max 1 call per reply with a 2.5s " +
          "cooldown, so don't try to chain them. Never narrate the call (\"let " +
          "me show you\"); just call it. Examples:\n" +
          "  voice_visual({kind:\"mood\", value:\"excited\"}) — user shares good news\n" +
          "  voice_visual({kind:\"emoji\", value:\"🙂\"}) — friendly beat\n" +
          "  voice_visual({kind:\"shape\", value:\"heart\"}) — sweet moment\n" +
          "  voice_visual({kind:\"text\", value:\"yes!\"}) — emphatic agreement\n" +
          "  voice_visual({kind:\"mood\", value:\"thinking\"}) — working through something\n" +
          "Default to NO call. Quality > frequency."
        : "\nYou have no tools right now — don't try to call any. If the user " +
          "needs something tool-driven (open an app, change a setting, search " +
          "the web), tell them to switch to the text chat for that.";
      const voiceSystemPrompt = prepared.systemPrompt +
        "\n\n## Voice mode\n" +
        "You are speaking to the user. Your reply will be read aloud by TTS. " +
        "Reply in 1-3 short conversational sentences. No markdown, no lists, " +
        "no code, no headings, no emoji in the spoken text. Use natural " +
        "spoken English." + visualPromptTail;

      let assistantText = "";
      const onEvent = (event: ServerEvent) => {
        if (event.type === "stream" && "delta" in event && event.delta) {
          assistantText += event.delta;
          onDelta(event.delta);
        } else if (event.type === "visual" && onVisual) {
          // Forward the visual directive through to the voice WebSocket.
          onVisual(event.kind, event.value, event.durationMs);
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
          // Headroom for a result-bearing tool turn (call → interpret).
          // voice_visual is fire-and-forget (silent-tool-check), so a
          // visual-only reply terminates in one turn and never re-speaks.
          maxIterations: visualsEnabled ? 2 : 1,
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

      const updatedHistory = [
        ...history,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: finalAssistantText || "[no reply]" },
      ];

      return { assistantText: finalAssistantText, updatedHistory };
    };

    setVoiceSessionFactory(createVoiceSessionFactory(voiceTurnRunner, (name) => secretsStore.get(name) || ""));
  } catch (e) { logger.warn("[voice-ws] setup failed:", (e as Error).message); }
}
