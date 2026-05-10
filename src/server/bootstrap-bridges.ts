import { existsSync } from "node:fs";
import { join } from "node:path";
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

import type { BridgeReply } from "../whatsapp-bridge.js";

export type BridgeHandler = (
  platform: string,
  payload: { from: string; name: string; text: string; sessionId: string }
) => Promise<string | BridgeReply>;

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
        return "Voice replies enabled. Reply with /voice off to switch back to text. " +
          "If you get text back anyway, no voice engine is running — send /voice start to bring one up.";
      }
      if (trimmed === "/voice off") {
        setVoicePref(platformKey, from, false);
        return "Voice replies disabled.";
      }
      const on = getVoicePref(platformKey, from);
      return `Voice replies are currently ${on ? "ON" : "OFF"}. Toggle with /voice on or /voice off. Engine controls: /voice start | /voice stop | /voice status.`;
    }

    // /voice start|stop|status [tier] — remote control of the voice
    // sidecar processes (Lite / Studio Chatterbox / SoVITS). Lets the user
    // bring an engine up from their phone when they're away from the
    // computer, without needing the Settings UI. Hits the same
    // /api/voices/setup/start | /stop endpoints the UI uses, just from
    // inside the server (localhost loopback).
    if (trimmed.startsWith("/voice start") || trimmed.startsWith("/voice stop") || trimmed.startsWith("/voice status")) {
      if (channelType !== "telegram" && channelType !== "whatsapp") {
        return "Voice engine control is not supported on this platform.";
      }
      const parts = trimmed.split(/\s+/);
      const action = parts[1] as "start" | "stop" | "status";
      const tierArg = (parts[2] || "lite").toLowerCase();
      const tierMap: Record<string, string> = {
        lite: "lite",
        studio: "studio-chatterbox",
        chatterbox: "studio-chatterbox",
        sovits: "studio-sovits",
      };
      const tierId = tierMap[tierArg];
      if (!tierId) return "Unknown tier. Use: lite (default) | studio | sovits.";

      const port = process.env.LAX_PORT || "7007";
      const base = `http://127.0.0.1:${port}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const tok = (config as { authToken?: string }).authToken;
      if (tok) headers["Authorization"] = `Bearer ${tok}`;

      try {
        if (action === "status") {
          const r = await fetch(`${base}/api/voices/setup`, { headers });
          if (!r.ok) return `Status check failed: HTTP ${r.status}`;
          const data = await r.json() as { tiers?: Array<{ id: string; label: string; running: boolean; installed: boolean }> };
          const t = (data.tiers ?? []).find(x => x.id === tierId);
          if (!t) return `Unknown tier id ${tierId}.`;
          return `${t.label}: ${t.running ? "running" : t.installed ? "installed, not running" : "not installed"}.`;
        }
        if (action === "stop") {
          const r = await fetch(`${base}/api/voices/setup/stop`, { method: "POST", headers, body: JSON.stringify({ tierId }) });
          if (!r.ok) return `Stop failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
          return `Stopped ${tierArg}.`;
        }
        // start — heavy (90-120s cold start on first launch). The setup/
        // start endpoint blocks until /healthz returns OK, which can
        // exceed bridge handler timeouts. Fire-and-forget here, return
        // immediately with a "kicked off" message; the user can /voice
        // status to poll.
        void fetch(`${base}/api/voices/setup/start`, { method: "POST", headers, body: JSON.stringify({ tierId }) })
          .then(async r => {
            if (!r.ok) logger.warn(`[bridge:${platform}] /voice start ${tierArg} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
            else logger.info(`[bridge:${platform}] /voice start ${tierArg} succeeded`);
          })
          .catch(e => logger.warn(`[bridge:${platform}] /voice start ${tierArg} threw: ${(e as Error).message}`));
        return `Starting ${tierArg} sidecar — cold start is 90-120s. Send /voice status ${tierArg} to check, or just wait and try voice replies in ~2 min.`;
      } catch (e) {
        return `Voice engine ${action} failed: ${(e as Error).message}`;
      }
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

    // Scan this turn's tool_result rows for vision-tool image bytes
    // (browser screenshot, image_read, etc.) and forward them to the
    // user via the channel's image-send API. Mirrors the legacy
    // result.messages scan, but reads from op_messages — the
    // chat-tool-dispatcher rides image bytes on the result envelope
    // as { text, images: [{mime, b64}] } when a tool emits them.
    if (canonicalOpId) {
      try {
        const { readOpMessages } = await import("../canonical-loop/store.js");
        const images: Buffer[] = [];
        for (const row of readOpMessages(canonicalOpId)) {
          if (row.role !== "tool_result") continue;
          const r = (row.content as { result?: unknown })?.result;
          if (!r || typeof r !== "object") continue;
          const imgs = (r as { images?: unknown }).images;
          if (!Array.isArray(imgs)) continue;
          for (const img of imgs) {
            if (!img || typeof img !== "object") continue;
            const b64 = (img as { b64?: unknown }).b64;
            if (typeof b64 !== "string") continue;
            try { images.push(Buffer.from(b64, "base64")); } catch { /* skip malformed */ }
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
      } catch (e) {
        logger.warn(`[bridge:${platform}] image scan failed: ${(e as Error).message}`);
      }
    }

    // Return BOTH the channel-formatted wire text and the raw speakable
    // text so bridges can route each to the right destination:
    //   text       → sendMessage (escapes preserved for MarkdownV2 etc.)
    //   speakable  → synthesize() (no bridge-formatter escapes — TTS reads
    //                what the agent wrote, not "\." pronounced "backslash dot")
    const raw = assistantText.trim() || "Done.";
    return {
      text: formatForChannel(raw, channelType).join("\n\n"),
      speakable: raw,
    };
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
  // WhatsApp auto-reconnect on boot. Only attempts when a saved Baileys
  // session exists (creds.json under whatsapp-auth/) — otherwise the
  // first connect generates a fresh QR that nobody is around to scan,
  // wasting cycles. Mirrors the telegram pattern. The bridge's connect
  // method is idempotent and returns immediately if already connected.
  const waCredsPath = join(dataDir, "whatsapp-auth", "creds.json");
  if (existsSync(waCredsPath)) {
    whatsappBridge.connect()
      .then(r => { if (r.state === "connected") logger.info(`[whatsapp] Auto-reconnected as ${r.phone || "(phone unknown)"}`); })
      .catch((e: Error) => logger.warn(`[whatsapp] Auto-reconnect failed: ${e.message}`));
  }
  return { whatsappBridge, telegramBridge, bridgeMessageHandler: bridgeHandler };
}
