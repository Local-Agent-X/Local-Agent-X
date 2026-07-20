/**
 * Telegram Bot Bridge
 *
 * Chat with your agent via Telegram. Create a bot with @BotFather,
 * paste the token, connect. No libraries — pure HTTP to Telegram Bot API.
 * Uses long polling (getUpdates) — no webhook, no public URL needed.
 */

import type { TelegramBridge as TelegramBridgeClass } from "./bridge.js";
import { getMessagingBridge, setMessagingBridge } from "../session/channel-registry.js";

export { TelegramBridge } from "./bridge.js";
export type { TelegramBridgeConfig } from "./types.js";

// Module-singleton handle to the live bridge so tools (telegram_send) and
// scheduled missions can push PROACTIVE messages. The inbound reply path rides
// onMessage, but a cron ping has no inbound turn to ride — it needs the bridge
// object directly. Set once at bootstrap (bootstrap-bridges.ts).
export function setTelegramBridgeInstance(b: TelegramBridgeClass | null): void {
  setMessagingBridge("telegram", b);
}
export function getTelegramBridgeInstance(): TelegramBridgeClass | null {
  return getMessagingBridge("telegram");
}
