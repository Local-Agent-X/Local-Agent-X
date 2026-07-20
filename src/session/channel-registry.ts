import { join } from "node:path";
import type { TelegramBridge } from "../telegram-bridge/index.js";
import type { WhatsAppBridge } from "../whatsapp-bridge/index.js";

export type MessagingChannelId = "telegram" | "whatsapp";

export interface MessagingChannelDefinition {
  readonly id: MessagingChannelId;
  readonly displayName: "Telegram" | "WhatsApp";
  readonly sessionPrefix: "tg-" | "wa-";
  readonly configFile: "telegram-config.json" | "whatsapp-config.json";
  readonly tokenSecret: "TELEGRAM_BOT_TOKEN" | null;
  readonly authDirectory: "whatsapp-auth" | null;
  readonly authReadyFile: "creds.json" | null;
  readonly supportsQrPairing: boolean;
}

const definitions: Record<MessagingChannelId, MessagingChannelDefinition> = {
  telegram: Object.freeze({
    id: "telegram",
    displayName: "Telegram",
    sessionPrefix: "tg-",
    configFile: "telegram-config.json",
    tokenSecret: "TELEGRAM_BOT_TOKEN",
    authDirectory: null,
    authReadyFile: null,
    supportsQrPairing: false,
  }),
  whatsapp: Object.freeze({
    id: "whatsapp",
    displayName: "WhatsApp",
    sessionPrefix: "wa-",
    configFile: "whatsapp-config.json",
    tokenSecret: null,
    authDirectory: "whatsapp-auth",
    authReadyFile: "creds.json",
    supportsQrPairing: true,
  }),
};

export function isMessagingChannelId(value: unknown): value is MessagingChannelId {
  return value === "telegram" || value === "whatsapp";
}

export function getMessagingChannelDefinition(id: MessagingChannelId): MessagingChannelDefinition {
  return definitions[id];
}

export function messagingChannelConfigPath(dataDir: string, id: MessagingChannelId): string {
  return join(dataDir, definitions[id].configFile);
}

export function messagingChannelAuthPath(dataDir: string, id: MessagingChannelId): string | null {
  const directory = definitions[id].authDirectory;
  return directory ? join(dataDir, directory) : null;
}

export function messagingChannelAuthReadyPath(dataDir: string, id: MessagingChannelId): string | null {
  const definition = definitions[id];
  return definition.authDirectory && definition.authReadyFile
    ? join(dataDir, definition.authDirectory, definition.authReadyFile)
    : null;
}

export function parseMessagingSessionTarget(
  sessionId: string,
): { channel: MessagingChannelId; target: string } | null {
  for (const id of Object.keys(definitions) as MessagingChannelId[]) {
    const prefix = definitions[id].sessionPrefix;
    if (sessionId.startsWith(prefix)) return { channel: id, target: sessionId.slice(prefix.length) };
  }
  return null;
}

export function buildMessagingSessionId(id: MessagingChannelId, target: string): string {
  return `${definitions[id].sessionPrefix}${target}`;
}

interface MessagingBridgeMap {
  telegram: TelegramBridge;
  whatsapp: WhatsAppBridge;
}

const liveBridges: Partial<MessagingBridgeMap> = {};

export function setMessagingBridge<T extends MessagingChannelId>(
  id: T,
  bridge: MessagingBridgeMap[T] | null,
): void {
  if (bridge === null) delete liveBridges[id];
  else liveBridges[id] = bridge;
}

export function getMessagingBridge<T extends MessagingChannelId>(id: T): MessagingBridgeMap[T] | null {
  return (liveBridges[id] as MessagingBridgeMap[T] | undefined) ?? null;
}
