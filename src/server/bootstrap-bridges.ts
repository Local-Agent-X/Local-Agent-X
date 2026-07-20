import { existsSync } from "node:fs";
import { WhatsAppBridge, setWhatsAppBridgeInstance, type BridgeReply } from "../whatsapp-bridge/index.js";
import { TelegramBridge, setTelegramBridgeInstance } from "../telegram-bridge/index.js";
import { resolveSession, type ChannelType } from "../session/router.js";
import { detectInjection } from "../sanitize.js";
import { getVoicePref, setVoicePref, type BridgePlatform } from "../bridge-voice/index.js";
import { VOICE_COMMAND_TIER_MAP } from "../routes/bridges/voice-setup/tiers.js";
import { sendRestartPingIfPending } from "../restart-notify.js";
import type { LAXConfig, Session } from "../types.js";
import type { SessionStore } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { ServerContext } from "../server-context.js";
import { createLogger } from "../logger.js";
import { isLocalOnlyMode, registerLocalOnlyTeardown } from "../local-only-policy.js";
import {
  getMessagingChannelDefinition,
  messagingChannelAuthReadyPath,
  type MessagingChannelId,
} from "../session/channel-registry.js";
import { createInboundChannelRunner, type InboundChannelPayload } from "./inbound-channel-runner.js";

const logger = createLogger("server.bootstrap-bridges");

export type BridgeHandler = (
  platform: MessagingChannelId,
  payload: InboundChannelPayload,
) => Promise<string | BridgeReply | null>;

interface BridgeHandlerDeps {
  sessions: Map<string, Session>;
  sessionStore: SessionStore;
  config: LAXConfig;
  getContext: () => Promise<ServerContext>;
}

export function createBridgeHandler(deps: BridgeHandlerDeps): BridgeHandler {
  const runInbound = createInboundChannelRunner({ getContext: deps.getContext });
  return async function bridgeMessageHandler(platform, payload) {
    const { from, text, sessionId } = payload;
    const channelType = platform as ChannelType;
    const route = resolveSession(channelType, from, sessionId);
    const trimmed = text.trim().toLowerCase();

    if (trimmed === "/reset" || trimmed === "/clear" || trimmed === "/new") {
      try {
        deps.sessions.delete(route.sessionKey);
        deps.sessionStore.delete(route.sessionKey);
        return "Fresh start. Conversation history cleared.";
      } catch (e) {
        return `Reset failed: ${(e as Error).message}`;
      }
    }

    const voiceToggle = handleVoiceToggle(channelType, from, trimmed);
    if (voiceToggle) return voiceToggle;
    const voiceControl = await handleVoiceControl(channelType, trimmed, deps.config, platform);
    if (voiceControl) return voiceControl;

    const injectionScore = detectInjection(text).reduce((max, hit) => Math.max(max, hit.score), 0);
    if (injectionScore >= 0.85) return "I can't process that message — it was flagged by security filters.";
    return runInbound(platform, payload);
  };
}

function handleVoiceToggle(channel: ChannelType, from: string, command: string): string | null {
  if (command !== "/voice" && command !== "/voice on" && command !== "/voice off") return null;
  if (channel !== "telegram" && channel !== "whatsapp") return "Voice replies are not supported on this platform.";
  const platform = channel as BridgePlatform;
  if (command === "/voice on") {
    setVoicePref(platform, from, true);
    return "Voice replies enabled. Reply with /voice off to switch back to text. If you get text back anyway, no voice engine is running — send /voice start to bring one up.";
  }
  if (command === "/voice off") {
    setVoicePref(platform, from, false);
    return "Voice replies disabled.";
  }
  const on = getVoicePref(platform, from);
  return `Voice replies are currently ${on ? "ON" : "OFF"}. Toggle with /voice on or /voice off. Engine controls: /voice start | /voice stop | /voice status.`;
}

async function handleVoiceControl(
  channel: ChannelType,
  command: string,
  config: LAXConfig,
  platform: MessagingChannelId,
): Promise<string | null> {
  if (!command.startsWith("/voice start") && !command.startsWith("/voice stop") && !command.startsWith("/voice status")) return null;
  if (channel !== "telegram" && channel !== "whatsapp") return "Voice engine control is not supported on this platform.";
  const parts = command.split(/\s+/);
  const action = parts[1] as "start" | "stop" | "status";
  const tierArg = (parts[2] || "lite").toLowerCase();
  const tierId = VOICE_COMMAND_TIER_MAP[tierArg];
  if (!tierId) return "Unknown tier. Use: lite (default) | studio.";
  const base = `http://127.0.0.1:${process.env.LAX_PORT || "7007"}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = (config as { authToken?: string }).authToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    if (action === "status") {
      const response = await fetch(`${base}/api/voices/setup/status`, { headers });
      if (!response.ok) return `Status check failed: HTTP ${response.status}`;
      const body = await response.json() as { tiers?: Array<{ id: string; label: string; running: boolean; installed: boolean }> };
      const tier = (body.tiers ?? []).find((candidate) => candidate.id === tierId);
      return tier ? `${tier.label}: ${tier.running ? "running" : tier.installed ? "installed, not running" : "not installed"}.` : `Unknown tier id ${tierId}.`;
    }
    if (action === "stop") {
      const response = await fetch(`${base}/api/voices/setup/stop`, { method: "POST", headers, body: JSON.stringify({ tier: tierId }) });
      return response.ok ? `Stopped ${tierArg}.` : `Stop failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
    }
    void fetch(`${base}/api/voices/setup/start`, { method: "POST", headers, body: JSON.stringify({ tier: tierId }) })
      .then(async (response) => {
        if (!response.ok) logger.warn(`[bridge:${platform}] /voice start ${tierArg} failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      })
      .catch((e: Error) => logger.warn(`[bridge:${platform}] /voice start ${tierArg} threw: ${e.message}`));
    return `Starting ${tierArg} sidecar — cold start is 90-120s. Send /voice status ${tierArg} to check, or just wait and try voice replies in ~2 min.`;
  } catch (e) {
    return `Voice engine ${action} failed: ${(e as Error).message}`;
  }
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
  const whatsappBridge = new WhatsAppBridge({ dataDir, onMessage: (payload) => bridgeHandler("whatsapp", payload) });
  setWhatsAppBridgeInstance(whatsappBridge);
  const telegramDefinition = getMessagingChannelDefinition("telegram");
  const telegramBridge = new TelegramBridge({
    dataDir,
    getToken: () => secretsStore.get(telegramDefinition.tokenSecret!) ?? null,
    onMessage: (payload) => bridgeHandler("telegram", payload),
  });
  setTelegramBridgeInstance(telegramBridge);
  registerLocalOnlyTeardown("messaging-bridges", () => {
    telegramBridge.disconnect();
    return whatsappBridge.disconnect(true);
  });
  if (!isLocalOnlyMode() && secretsStore.has(telegramDefinition.tokenSecret!)) {
    telegramBridge.connect().then((result) => {
      if (result.state === "connected") {
        logger.info(`[telegram] Auto-reconnected as @${result.botUsername}`);
        void sendRestartPingIfPending("telegram");
      }
    }).catch(() => {});
  }
  const credentials = messagingChannelAuthReadyPath(dataDir, "whatsapp")!;
  if (!isLocalOnlyMode() && existsSync(credentials)) {
    whatsappBridge.connect().then((result) => {
      if (result.state === "connected") {
        logger.info(`[whatsapp] Auto-reconnected as ${result.phone || "(phone unknown)"}`);
        void sendRestartPingIfPending("whatsapp");
      }
    }).catch((e: Error) => logger.warn(`[whatsapp] Auto-reconnect failed: ${e.message}`));
  }
  return { whatsappBridge, telegramBridge, bridgeMessageHandler: bridgeHandler };
}
