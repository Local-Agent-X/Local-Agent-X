import { runAgent, type AgentOptions } from "../agent.js";
import { stripEphemeralMessages } from "../agent-providers.js";
import { WhatsAppBridge } from "../whatsapp-bridge.js";
import { TelegramBridge } from "../telegram-bridge.js";
import { enqueue } from "../execution-lanes.js";
import { formatForChannel, getChannelConfig } from "../channel-formatter.js";
import { resolveSession, buildChannelContext, type ChannelType } from "../session-router.js";
import { detectInjection } from "../sanitize.js";
import { getVoicePref, setVoicePref, type BridgePlatform } from "../bridge-voice/index.js";
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
    const result = await enqueue("main", () => runAgent(text, prepared.cleanHistory, {
      apiKey: prepared.apiKey, model: prepared.model,
      provider: prepared.provider as AgentOptions["provider"],
      systemPrompt: prepared.systemPrompt, tools: prepared.tools,
      security, toolPolicy, rbac, callerRole: "operator" as const,
      sessionId: route.sessionKey, maxIterations: prepared.maxIterations,
      temperature: prepared.temperature,
    }), { label: `bridge:${platform}:${from}` });
    const toolCallsMade = result.messages.filter(m => {
      const tc = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
      return m.role === "assistant" && Array.isArray(tc) && tc.length > 0;
    }).length;
    logger.info(`[bridge:${platform}] done — ${result.messages.length} msgs, ${toolCallsMade} tool-call turns, stopReason=${result.stopReason}`);

    const turnStartIdx = prepared.cleanHistory.length;
    const images: Buffer[] = [];
    for (let i = turnStartIdx; i < result.messages.length; i++) {
      const m = result.messages[i];
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const part of m.content as Array<{ type: string; image_url?: { url: string } }>) {
        if (part.type !== "image_url" || !part.image_url?.url) continue;
        const match = /^data:[^;]+;base64,(.+)$/.exec(part.image_url.url);
        if (!match) continue;
        try { images.push(Buffer.from(match[1], "base64")); } catch {}
      }
    }
    if (images.length > 0) {
      logger.info(`[bridge:${platform}] sending ${images.length} image(s) to ${from}`);
      for (const img of images) {
        if (channelType === "whatsapp") {
          await getWhatsappBridge().sendImage(from, img).catch((e: Error) => logger.error(`[whatsapp] image send failed: ${e.message}`));
        } else if (channelType === "telegram") {
          await getTelegramBridge().sendPhoto(from, img).catch((e: Error) => logger.error(`[telegram] photo send failed: ${e.message}`));
        }
      }
    }

    session.messages = stripEphemeralMessages(result.messages).filter(m => {
      if (m.role === "system") return false;
      if (m.role === "tool") return true;
      return m.content || (m as unknown as Record<string, unknown>).tool_calls;
    });
    session.updatedAt = Date.now(); saveSession(session);
    return formatForChannel(result.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => m.content as string).pop() || "Done.", channelType).join("\n\n");
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
