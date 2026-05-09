import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { stripEphemeralMessages } from "../agent-providers.js";
import { WhatsAppBridge } from "../whatsapp-bridge.js";
import { TelegramBridge } from "../telegram-bridge.js";
import { formatForChannel, getChannelConfig } from "../channel-formatter.js";
import { resolveSession, buildChannelContext, type ChannelType } from "../session-router.js";
import { detectInjection } from "../sanitize.js";
import { getVoicePref, setVoicePref, type BridgePlatform } from "../bridge-voice/index.js";
import { COMPACTION_PREFIX } from "../types.js";
import type { LAXConfig, Session, ToolDefinition } from "../types.js";
import type { SessionStore, MemoryIndex, MemoryManager } from "../memory.js";
import type { SecretsStore } from "../secrets.js";
import type { IntegrationRegistry } from "../integrations.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { RBACManager } from "../rbac.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.bootstrap-bridges");

export type BridgeHandler = (
  platform: string,
  payload: { from: string; name: string; text: string; sessionId: string }
) => Promise<string>;

export function createBridgeHandler(deps: {
  sessions: Map<string, Session>;
  sessionStore: SessionStore;
  getOrCreateSession: (id: string) => Session;
  saveSession: (s: Session) => Promise<void>;
  config: LAXConfig;
  dataDir: string;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  integrations: IntegrationRegistry;
  secretsStore: SecretsStore;
  allAgentToolsRef: { value: ToolDefinition[] };
  bridgeToolsRef: { value: ToolDefinition[] };
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  rbac: RBACManager;
  getWhatsappBridge: () => WhatsAppBridge;
  getTelegramBridge: () => TelegramBridge;
}): BridgeHandler {
  const {
    sessions, sessionStore, getOrCreateSession, saveSession,
    config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
    allAgentToolsRef, bridgeToolsRef, security, toolPolicy, rbac,
    getWhatsappBridge, getTelegramBridge,
  } = deps;

  return async function bridgeMessageHandler(platform, { from, name, text, sessionId }) {
    const channelType = platform.toLowerCase() as ChannelType;
    const route = resolveSession(channelType, from, sessionId);

    const trimmed = text.trim().toLowerCase();
    if (trimmed === "/reset" || trimmed === "/clear" || trimmed === "/new") {
      try {
        sessions.delete(route.sessionKey);
        sessionStore.delete(route.sessionKey);
        return "Fresh start. Conversation history cleared.";
      } catch (e) {
        return `Reset failed: ${(e as Error).message}`;
      }
    }

    // /voice on|off — per-chat voice-reply toggle, persisted to
    // ~/.lax/bridge-voice-prefs.json. Bare /voice reports current state.
    // Only valid on platforms that have a voice path (telegram, whatsapp).
    if (trimmed === "/voice" || trimmed === "/voice on" || trimmed === "/voice off") {
      if (channelType !== "telegram" && channelType !== "whatsapp") {
        return "Voice replies are not supported on this platform.";
      }
      const platformKey = channelType as BridgePlatform;
      if (trimmed === "/voice on") {
        setVoicePref(platformKey, from, true);
        return "Voice replies enabled. Reply with /voice off to switch back to text.";
      }
      if (trimmed === "/voice off") {
        setVoicePref(platformKey, from, false);
        return "Voice replies disabled.";
      }
      const on = getVoicePref(platformKey, from);
      return `Voice replies are currently ${on ? "ON" : "OFF"}. Toggle with /voice on or /voice off.`;
    }

    const session = getOrCreateSession(route.sessionKey);
    if (session.messages.length === 0) session.title = `${platform}: ${name}`;
    const injectionScore = detectInjection(text).reduce((max, h) => Math.max(max, h.score), 0);
    if (injectionScore >= 0.85) return `I can't process that message — it was flagged by security filters.`;

    const { prepareAgentRequest } = await import("../agent-request.js");
    const channelConfig = getChannelConfig(channelType);
    const bridgeCtx = `\n\n[${platform} bridge] ${buildChannelContext(route)}. Message from ${name} (${from}). ` +
      `Keep responses concise — max ~${channelConfig.maxTextLength === Infinity ? "unlimited" : channelConfig.maxTextLength} chars. ` +
      (channelConfig.markdownFlavor === "plain" ? "Use plain text only. " : channelConfig.markdownFlavor === "whatsapp" ? "Use minimal formatting. " : "");
    const prepared = await prepareAgentRequest({
      channel: channelType as "telegram" | "whatsapp",
      message: text, sessionMessages: session.messages, sessionId: route.sessionKey,
      config, dataDir, memoryIndex, memoryManager, integrations, secretsStore,
      allAgentTools: allAgentToolsRef.value, bridgeTools: bridgeToolsRef.value, skipMemory: true, maxHistory: 30,
      bridgeContext: bridgeCtx,
    });

    logger.info(`[bridge:${platform}] provider=${prepared.provider} model=${prepared.model} tools=${prepared.tools.length} (${prepared.tools.slice(0, 5).map(t => t.name).join(",")}${prepared.tools.length > 5 ? ",..." : ""})`);

    // Bridge handlers consume canonical-loop too. Same dispatch path the
    // web chat uses — runChatViaCanonical yields ServerEvents; we
    // collect text into a single response (bridges don't stream to the
    // user — Telegram/WhatsApp send one message per reply).
    const { runChatViaCanonical } = await import("../canonical-loop/chat-runner.js");
    let assistantText = "";
    let canonicalOpId = "";
    let firstError: string | null = null;
    const eventStream = runChatViaCanonical({
      message: text,
      sessionId: route.sessionKey,
      prepared,
      tools: prepared.tools,
      security,
      toolPolicy,
      rbac,
      callerRole: "operator" as const,
    });
    for await (const ev of eventStream) {
      if (ev.type === "stream" && typeof ev.delta === "string") {
        assistantText += ev.delta;
      } else if (ev.type === "chat_op_started" && typeof ev.opId === "string") {
        canonicalOpId = ev.opId;
      } else if (ev.type === "error" && typeof ev.message === "string" && !firstError) {
        firstError = ev.message;
      }
    }
    if (firstError && !assistantText) {
      logger.warn(`[bridge:${platform}] canonical errored: ${firstError}`);
    }

    // Persist session.messages by reading the just-finished op's
    // message rows (same pattern as chat.ts canonical persist —
    // captures tool_calls + tool_result structure that text-only
    // synthesis would lose).
    if (canonicalOpId) {
      try {
        const { readOpMessages } = await import("../canonical-loop/store.js");
        const { opMessageRowToChatParam } = await import("../canonical-loop/chat-runner.js");
        const newRows: ChatCompletionMessageParam[] = [];
        for (const row of readOpMessages(canonicalOpId)) {
          if (row.messageId.startsWith("hist-")) continue;
          const param = opMessageRowToChatParam(row);
          if (param) newRows.push(param);
        }
        type MsgRecord = Record<string, unknown>;
        session.messages = stripEphemeralMessages([...session.messages, ...newRows]).filter(m => {
          if (m.role === "system") {
            return typeof m.content === "string" && m.content.startsWith(COMPACTION_PREFIX);
          }
          if (m.role === "tool") return true;
          return m.content || (m as unknown as MsgRecord).tool_calls;
        });
      } catch (e) {
        logger.warn(`[bridge:${platform}] canonical persist read failed: ${(e as Error).message}`);
      }
    }
    // Fallback: if op_messages read produced nothing (unlikely), at
    // least preserve the user message + assistant text we observed
    // streaming. Mirrors the same defensive path in chat.ts canonical
    // persist.
    if (canonicalOpId === "" || (session.messages[session.messages.length - 1]?.role !== "assistant" && assistantText)) {
      session.messages = [
        ...session.messages,
        { role: "user", content: text },
        ...(assistantText ? [{ role: "assistant" as const, content: assistantText }] : []),
      ];
    }
    session.updatedAt = Date.now();
    saveSession(session);

    // TODO: image-sending from agent-generated images (browser
    // screenshots, generated artwork). The legacy path scanned
    // result.messages for user-role image_url content parts (how the
    // OpenAI client wraps tool-result images for the model). The
    // canonical equivalent lives in op_messages tool_result rows; the
    // shape varies per tool. Wire this back up in a follow-up commit
    // once the basic text path is verified.

    return formatForChannel(assistantText.trim() || "Done.", channelType).join("\n\n");
  };
}

export interface BridgeBundle {
  whatsappBridge: WhatsAppBridge;
  telegramBridge: TelegramBridge;
  bridgeMessageHandler: BridgeHandler;
}

export function bootstrapBridges(deps: {
  dataDir: string;
  secretsStore: SecretsStore;
  bridgeHandler: BridgeHandler;
}): BridgeBundle {
  const { dataDir, secretsStore, bridgeHandler } = deps;
  const whatsappBridge = new WhatsAppBridge({ dataDir, onMessage: (p) => bridgeHandler("WhatsApp", p) });
  const telegramBridge = new TelegramBridge({ dataDir, getToken: () => secretsStore.get("TELEGRAM_BOT_TOKEN") ?? null, onMessage: (p) => bridgeHandler("Telegram", p) });
  if (secretsStore.has("TELEGRAM_BOT_TOKEN")) telegramBridge.connect().then(r => { if (r.state === "connected") logger.info(`[telegram] Auto-reconnected as @${r.botUsername}`); }).catch(() => {});
  return { whatsappBridge, telegramBridge, bridgeMessageHandler: bridgeHandler };
}
