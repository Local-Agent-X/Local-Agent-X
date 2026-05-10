/**
 * Reply payload returned by `onMessage`. `text` is the channel-formatted
 * string sent verbatim via `sendMessage` (WhatsApp markdown flavor — escaped
 * for the wire). `speakable` is the RAW unformatted reply used for TTS;
 * without this split the TTS path reads bridge-escape characters literally
 * (Windows SAPI famously narrated the word "backslash" for every Telegram
 * MarkdownV2 escape). Bridges fall back to `text` when `speakable` is
 * absent so legacy / synchronous-string returns still work.
 */
export interface BridgeReply {
  text: string;
  speakable?: string;
}

export interface WhatsAppBridgeConfig {
  dataDir: string;  // ~/.sax — session auth persisted here
  onMessage: (params: {
    from: string;
    name: string;
    text: string;
    sessionId: string;
  }) => Promise<string | BridgeReply>;
}

export type ConnectionState = "disconnected" | "connecting" | "qr" | "connected";

export interface QueuedMessage {
  from: string;
  name: string;
  text: string;
  timestamp: number;
}
