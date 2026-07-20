import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildMessagingSessionId, messagingChannelConfigPath } from "../session/channel-registry.js";

import { apiCall, sendMessage, sendVoice, sendPhoto, sendVideo } from "./api.js";
import { describeNonTextMessage, dispatchReply, transcribeInboundVoice } from "./inbound.js";
import {
  _voiceMirrorForChat,
  type ConnectionState,
  logger,
  type TelegramBridgeConfig,
  type TelegramUser,
} from "./types.js";

/** Exponential poll backoff capped at 60s. Never gives up — the loop retries
 *  indefinitely (only a 401 is terminal); the exponent is clamped so the delay
 *  stays a finite number no matter how long the outage lasts. */
export function pollBackoffDelay(consecutiveErrors: number): number {
  return Math.min(5000 * 2 ** Math.min(consecutiveErrors - 1, 10), 60000);
}

export class TelegramBridge {
  private dataDir: string;
  private getToken: () => string | null;
  private onMessage: TelegramBridgeConfig["onMessage"];
  private state: ConnectionState = "disconnected";
  private botUser: TelegramUser | null = null;
  private lastError: string | null = null;
  private pollAbort: AbortController | null = null;
  private polling = false;
  private offset = 0;
  private processingLock = new Set<string>();
  private allowedChatIds: Set<string> = new Set();
  private ownerVerified = false;  // true once we've confirmed config loaded or owner locked

  constructor(config: TelegramBridgeConfig) {
    this.dataDir = config.dataDir;
    this.getToken = config.getToken;
    this.onMessage = config.onMessage;
    this.loadAllowedChats();
  }

  /** Connect: validate token via getMe, start long polling */
  async connect(): Promise<{ state: ConnectionState; botUsername?: string; botName?: string }> {
    // Always stop any existing poll before (re)connecting — prevents duplicate pollers
    this.stopPolling();

    const token = this.getToken();
    if (!token) {
      this.state = "error";
      this.lastError = "No TELEGRAM_BOT_TOKEN configured. Create a bot with @BotFather and save the token.";
      return { state: "error" };
    }

    this.state = "connecting";
    this.lastError = null;

    try {
      const me = await apiCall(token, "getMe");
      if (!me.ok) throw new Error(me.description || "Invalid bot token");
      this.botUser = me.result;

      // Re-load allowed chats in case config was updated while disconnected
      this.loadAllowedChats();

      this.state = "connected";
      logger.info(`[telegram] Connected as @${this.botUser!.username} (${this.botUser!.first_name})`);
      this.startPolling(token);
      return { state: "connected", botUsername: this.botUser!.username, botName: this.botUser!.first_name };
    } catch (e) {
      this.state = "error";
      this.lastError = (e as Error).message;
      logger.error("[telegram] Connect failed:", this.lastError);
      return { state: "error" };
    }
  }

  /** Disconnect: stop polling */
  disconnect(): void {
    this.stopPolling();
    this.state = "disconnected";
    this.botUser = null;
    this.lastError = null;
    logger.info("[telegram] Disconnected");
  }

  /** Send a text message to a Telegram chat */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;
    return sendMessage(token, chatId, text);
  }

  /** Send an OGG/Opus buffer as a Telegram voice note (rendered as a
   *  playable bubble in chat, not an attached file). */
  async sendVoice(chatId: string, ogg: Buffer): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;
    return sendVoice(token, chatId, ogg);
  }

  /** Send a photo (buffer) with optional caption. */
  async sendPhoto(chatId: string, image: Buffer, caption?: string): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;
    return sendPhoto(token, chatId, image, caption);
  }

  /** Send a video (buffer) with optional caption. */
  async sendVideo(chatId: string, video: Buffer, caption?: string): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;
    return sendVideo(token, chatId, video, caption);
  }

  /** Get current status */
  getStatus(): {
    state: ConnectionState;
    botUsername: string | null;
    botName: string | null;
    error: string | null;
    allowedChatIds: string[];
  } {
    return {
      state: this.state,
      botUsername: this.botUser?.username || null,
      botName: this.botUser?.first_name || null,
      error: this.lastError,
      allowedChatIds: [...this.allowedChatIds],
    };
  }

  /** Set which chat IDs can message the agent (empty = allow all) */
  setAllowedChatIds(ids: string[]): void {
    this.allowedChatIds = new Set(ids.map(String));
    this.saveAllowedChats();
  }

  // ── Private ──

  private startPolling(token: string): void {
    if (this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();
    this.pollLoop(token);
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollAbort) { this.pollAbort.abort(); this.pollAbort = null; }
  }

  private async pollLoop(token: string): Promise<void> {
    let consecutiveErrors = 0;

    while (this.polling) {
      try {
        const result = await apiCall(token, "getUpdates", {
          offset: this.offset, timeout: 30, allowed_updates: ["message"],
        }, this.pollAbort?.signal);

        if (!result.ok) {
          // 401 is the ONLY terminal poll error: the token is invalid or
          // revoked and retrying can never recover it. Every other failure
          // (router reboot, ISP blip, Telegram 5xx, DNS hiccup) is transient,
          // so we back off and keep polling at the 60s cap indefinitely rather
          // than permanently bricking the bridge after a few minutes of trouble.
          if (result.error_code === 401) {
            this.state = "error";
            this.lastError = "Bot token is invalid or revoked.";
            this.polling = false;
            return;
          }
          consecutiveErrors++;
          const delay = pollBackoffDelay(consecutiveErrors);
          logger.error(`[telegram] Poll error (attempt ${consecutiveErrors}, retry in ${Math.round(delay / 1000)}s): ${result.description}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        consecutiveErrors = 0;
        for (const update of result.result || []) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update, token);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        consecutiveErrors++;
        const delay = pollBackoffDelay(consecutiveErrors);
        logger.error(`[telegram] Poll error (attempt ${consecutiveErrors}, retry in ${Math.round(delay / 1000)}s): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private async handleUpdate(update: any, token: string): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat.id);
    const from = msg.from;
    const senderName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || chatId;

    // Security: require explicit owner configuration — no auto-lock to first message
    if (this.allowedChatIds.size === 0 && !this.ownerVerified) {
      logger.warn(`[telegram] Rejected message from ${chatId} (${senderName}) — no owner configured yet`);
      await this.sendMessage(chatId, `This bot has no owner configured yet. Please set your chat ID in the web UI settings before using Telegram.`);
      return;
    }

    if (!this.allowedChatIds.has(chatId)) {
      logger.info(`[telegram] Blocked message from unauthorized chat ${chatId} (${senderName})`);
      await this.sendMessage(chatId, `Access denied. This bot is locked to its owner.`);
      return;
    }

    // Inbound voice: try to transcribe via the bridge-voice STT helper
    // BEFORE falling back to the legacy "saved file path" placeholder.
    // On any failure (no ffmpeg, no model, hallucination filter, etc.)
    // transcribeInboundVoice returns "" and we fall through to the old path.
    // When we DO get a transcript, the helper marks this turn as
    // voice-mirrored so the reply goes back as a voice note regardless of
    // the per-chat toggle.
    let text = typeof msg.text === "string" ? msg.text : "";
    if (!text) {
      text = await transcribeInboundVoice(msg, token, chatId);
    }
    if (!text) {
      text = await describeNonTextMessage(msg, token) || "";
    }
    if (!text) return;
    if (text.length > 10000) {
      await this.sendMessage(chatId, "Message too long (max 10,000 characters).");
      return;
    }
    const sessionId = buildMessagingSessionId("telegram", chatId);

    const safeName = (senderName || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
    const safeText = text.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
    logger.info(`[telegram] ${safeName} (${chatId}): ${safeText}${text.length > 80 ? "..." : ""}`);

    // /stop | /cancel — hard-kill the running turn. Intercepted BEFORE the
    // processingLock bounce so it works mid-turn (the bounce would otherwise
    // swallow it). Doesn't depend on the model cooperating.
    const cmd = text.trim().toLowerCase();
    if (cmd === "/stop" || cmd === "/cancel") {
      const { stopBridgeTurn } = await import("../bridge-control.js");
      const n = await stopBridgeTurn("telegram", chatId, sessionId, "telegram-stop");
      await this.sendMessage(chatId, n > 0 ? "🛑 Stopped." : "Nothing running.");
      return;
    }

    if (this.processingLock.has(chatId)) {
      // A message arriving mid-turn is steering the running turn — inject it
      // instead of bouncing. Falls back to the old "still working" notice
      // only if the op already finished out from under us.
      const { injectBridgeTurn } = await import("../bridge-control.js");
      const injected = await injectBridgeTurn("telegram", chatId, sessionId, text, "telegram-inject");
      await this.sendMessage(chatId, injected ? "→ Got it — passing that to the running task." : "Still working on your last message...");
      return;
    }

    // Typing indicator — Telegram's typing state expires in ~5s, so we
    // re-send every 4s until the turn ends. Without this, long-running
    // agent turns (30s+) leave the user staring at a blank chat with no
    // signal that anything is happening.
    const sendTyping = () => apiCall(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    this.processingLock.add(chatId);
    try {
      const reply = await this.onMessage({
        from: chatId, name: senderName, text, sessionId,
        deliveryId: `update:${String(update.update_id)}`,
      });
      if (!reply) { /* nothing to send */ }
      else if (typeof reply === "string") {
        await dispatchReply(token, chatId, reply, reply);
      } else {
        await dispatchReply(token, chatId, reply.text, reply.speakable ?? reply.text);
      }
    } catch (e) {
      logger.error(`[telegram] Agent error for ${chatId}:`, (e as Error).message);
      await this.sendMessage(chatId, "Something went wrong. Try again?");
    } finally {
      clearInterval(typingInterval);
      this.processingLock.delete(chatId);
      _voiceMirrorForChat.delete(chatId);
    }
  }

  private loadAllowedChats(): void {
    try {
      const cfgPath = messagingChannelConfigPath(this.dataDir, "telegram");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.length > 0) {
          this.allowedChatIds = new Set(cfg.allowedChatIds.map(String));
          this.ownerVerified = true;
          logger.info(`[telegram] Loaded ${this.allowedChatIds.size} allowed chat(s) from config`);
        }
      }
    } catch (e) {
      logger.error("[telegram] Failed to load telegram-config.json:", (e as Error).message);
      // Don't set ownerVerified — allow auto-lock to work on next message
      // so the real owner can reclaim the bot after a config corruption
    }
  }

  private saveAllowedChats(): void {
    try {
      writeFileSync(
        messagingChannelConfigPath(this.dataDir, "telegram"),
        JSON.stringify({ allowedChatIds: [...this.allowedChatIds] }, null, 2),
      );
    } catch (e) {
      logger.error("[telegram] Failed to save config:", (e as Error).message);
    }
  }
}
