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
  /** Keep the provider delivery pending while canonical recovery is still running. */
  deferDelivery?: boolean;
  /** Durable inbound deliveries acknowledge only after the channel send settles. */
  acknowledgeDelivery?: (delivered: boolean) => Promise<void>;
  /** Resume multipart transport without resending parts already accepted by the provider. */
  isDeliveryPartComplete?: (part: string) => boolean;
  acknowledgeDeliveryPart?: (part: string) => Promise<void>;
  /** Freeze voice/text/fallback selection so a transport retry resumes the same wire plan. */
  readDeliveryPlan?: () => import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan | undefined;
  writeDeliveryPlan?: (plan: import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan) => Promise<void>;
}

export interface WhatsAppBridgeConfig {
  dataDir: string;  // ~/.lax — session auth persisted here
  onMessage: (params: {
    from: string;
    name: string;
    text: string;
    sessionId: string;
    deliveryId?: string;
    deliveryFingerprint?: string;
    deliveryTarget?: string;
    preferVoiceReply?: boolean;
    intent?: "turn" | "steer";
  }) => Promise<string | BridgeReply | null>;
}

export type ConnectionState = "disconnected" | "connecting" | "qr" | "connected";

export interface QueuedMessage {
  from: string;
  name: string;
  text: string;
  timestamp: number;
}
