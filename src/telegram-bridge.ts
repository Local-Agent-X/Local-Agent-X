/**
 * Telegram Bot Bridge
 *
 * Chat with your agent via Telegram. Create a bot with @BotFather,
 * paste the token, connect. No libraries — pure HTTP to Telegram Bot API.
 * Uses long polling (getUpdates) — no webhook, no public URL needed.
 */

export { TelegramBridge } from "./telegram-bridge/bridge.js";
export type { TelegramBridgeConfig } from "./telegram-bridge/types.js";
