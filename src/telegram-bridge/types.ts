import { createLogger } from "../logger.js";

export const logger = createLogger("telegram-bridge");

// Per-turn flag: when the user sent a voice note in, we reply via voice
// regardless of the toggle state for that single response. Keyed by chatId.
// Cleared after the reply is dispatched. This avoids widening BridgeHandler
// — the bridge already owns inbound/outbound side-effects so keeping the
// voice-vs-text decision local is the smaller surgery.
export const _voiceMirrorForChat = new Set<string>();
// Tracks chats we've already told "voice engine is down" so the hint only
// fires once per server-uptime per chat — avoids spamming every reply when
// the engine is offline. Resets on server restart so a fresh boot re-arms.
export const _voiceFailHintSent = new Set<string>();

export interface TelegramBridgeConfig {
  dataDir: string;
  getToken: () => string | null;
  // Returns either a plain channel-formatted string (legacy) or a
  // {text, speakable} pair so TTS gets the raw unescaped text. See
  // BridgeReply in whatsapp-bridge.ts for why this split exists.
  onMessage: (params: {
    from: string;
    name: string;
    text: string;
    sessionId: string;
  }) => Promise<string | import("../whatsapp-bridge/index.js").BridgeReply>;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
