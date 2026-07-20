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
import { runDurableInboundCommand } from "./durable-inbound-command.js";
import { readInboundCommandPlan, type DurableInboundCommandPlan } from "./inbound-delivery-store.js";

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
    const executePlan = async (plan: DurableInboundCommandPlan): Promise<string> => {
      if (plan.kind === "steer") {
        const { applyBridgeInjection } = await import("../bridge-control.js");
        const applied = typeof plan.targetOpId === "string"
          && await applyBridgeInjection(plan.targetOpId, String(plan.instruction), String(plan.actor), String(plan.ingressKey));
        return applied ? "→ Got it — passing that to the running task." : "Still working on your last message...";
      }
      if (plan.kind === "reset") {
        try {
          deps.sessions.delete(String(plan.sessionKey));
          deps.sessionStore.delete(String(plan.sessionKey));
          return "Fresh start. Conversation history cleared.";
        } catch (e) { return `Reset failed: ${(e as Error).message}`; }
      }
      if (plan.kind === "voice_pref") return handleVoiceToggle(channelType, String(plan.from), String(plan.command))!;
      if (plan.kind === "voice_control") return (await handleVoiceControl(channelType, String(plan.command), deps.config, platform))!;
      if (plan.kind === "stop") {
        const { cancelBridgeOps } = await import("../bridge-control.js");
        const targets = Array.isArray(plan.targetOpIds) ? plan.targetOpIds : [];
        await cancelBridgeOps(targets, String(plan.actor));
        return targets.length > 0 ? "🛑 Stopped." : "Nothing running.";
      }
      if (plan.kind === "approve") {
        const { grantConsentOnce } = await import("../threat/consent-store.js");
        grantConsentOnce(String(plan.ingressKey), String(plan.sessionKey), 30 * 60_000, String(plan.reason));
        if (typeof plan.fingerprint === "string") {
          const { recordApprovalOnce } = await import("../threat/trust-ledger.js");
          recordApprovalOnce(String(plan.ingressKey), plan.fingerprint, String(plan.reason));
        }
        return `✓ Consent granted for 30 minutes. Reason: ${String(plan.reason)}\n\nThe agent's next retry of the blocked tool will succeed.`;
      }
      throw new Error(`unknown durable inbound command: ${plan.kind}`);
    };
    const durableCommand = (plan: DurableInboundCommandPlan) => payload.deliveryId
      ? runDurableInboundCommand(platform, {
        from: payload.from, name: payload.name, text: payload.text, sessionId: route.sessionKey,
        deliveryId: payload.deliveryId, deliveryFingerprint: payload.deliveryFingerprint,
        deliveryTarget: payload.deliveryTarget, preferVoiceReply: payload.preferVoiceReply, intent: payload.intent,
      }, plan, executePlan)
      : executePlan(plan);
    const persistedPlan = payload.deliveryId ? readInboundCommandPlan({
      channel: platform, deliveryId: payload.deliveryId, sessionId: route.sessionKey,
      text: payload.deliveryFingerprint ?? payload.text,
    }) : null;
    if (persistedPlan) return durableCommand(persistedPlan);

    if (payload.intent === "steer") {
      const { resolveLiveBridgeOps } = await import("../bridge-control.js");
      const targetOpId = (await resolveLiveBridgeOps(platform, from, route.sessionKey)).at(-1) ?? null;
      const ingressKey = `inbound:${platform}:${payload.deliveryId ?? `${route.sessionKey}:${text}`}`;
      return durableCommand({ kind: "steer", targetOpId, instruction: text, actor: `${platform}-inject`, ingressKey });
    }

    if (trimmed === "/reset" || trimmed === "/clear" || trimmed === "/new") {
      return durableCommand({ kind: "reset", sessionKey: route.sessionKey });
    }

    if (trimmed === "/voice" || trimmed === "/voice on" || trimmed === "/voice off") {
      return durableCommand({ kind: "voice_pref", command: trimmed, from });
    }
    if (trimmed.startsWith("/voice start") || trimmed.startsWith("/voice stop") || trimmed.startsWith("/voice status")) {
      return durableCommand({ kind: "voice_control", command: trimmed });
    }
    if (trimmed === "/stop" || trimmed === "/cancel") {
      const { resolveLiveBridgeOps } = await import("../bridge-control.js");
      const targetOpIds = await resolveLiveBridgeOps(platform, from, route.sessionKey);
      return durableCommand({ kind: "stop", targetOpIds, actor: `${platform}-stop` });
    }

    if (/^\/approve\b/i.test(text)) {
      const reason = (text.replace(/^\s*\/approve\s*/i, "").trim() || "user-typed-/approve").slice(0, 160);
      const { getLastBlockedFingerprint } = await import("../threat/consent-store.js");
      const fingerprint = getLastBlockedFingerprint(route.sessionKey);
      const ingressKey = `inbound:${platform}:${payload.deliveryId ?? `${route.sessionKey}:${text}`}`;
      return durableCommand({ kind: "approve", sessionKey: route.sessionKey, reason, fingerprint, ingressKey });
    }

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
    const response = await fetch(`${base}/api/voices/setup/start`, { method: "POST", headers, body: JSON.stringify({ tier: tierId }) });
    if (!response.ok) return `Start failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
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
