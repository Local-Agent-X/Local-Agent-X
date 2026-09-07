import { buildMessagingSessionId } from "../session/channel-registry.js";

import {
  CLAIM_WINDOW_MS,
  claimWindowRemainingMs,
  loadAllowedChats,
  sanitizeChatIds,
  saveAllowedChats,
} from "./allowed-chats.js";

import { apiCall, sendMessage, sendVoice, sendPhoto, sendVideo } from "./api.js";
import { describeNonTextMessage, dispatchReply, transcribeInboundVoice } from "./inbound.js";
import {
  _voiceMirrorForChat,
  type ConnectionState,
  logger,
  type TelegramBridgeConfig,
  type TelegramUser,
} from "./types.js";

const CONTROL_COMMAND_IGNORABLE = /[\x00-\x1F\x7F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

function controlCommandKey(text: string): string {
  return text.replace(CONTROL_COMMAND_IGNORABLE, "").trim().toLowerCase();
}

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
  private pendingUpdates = new Map<number, { done: boolean; delivered: boolean }>();
  private pendingUpdateOrder: number[] = [];
  private allowedChatIds: Set<string> = new Set();
  private claimWindowExpiresAt = 0;

  constructor(config: TelegramBridgeConfig) {
    this.dataDir = config.dataDir;
    this.getToken = config.getToken;
    this.onMessage = config.onMessage;
    this.allowedChatIds = loadAllowedChats(this.dataDir);
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
      this.allowedChatIds = loadAllowedChats(this.dataDir);

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
    claimWindowMsRemaining: number;
  } {
    return {
      state: this.state,
      botUsername: this.botUser?.username || null,
      botName: this.botUser?.first_name || null,
      error: this.lastError,
      allowedChatIds: [...this.allowedChatIds],
      claimWindowMsRemaining: claimWindowRemainingMs(this.claimWindowExpiresAt, Date.now()),
    };
  }

  /** Set which chat IDs can message the agent. Empty list clears the owner,
   *  which leaves the bot default-denied until someone claims it again. */
  setAllowedChatIds(ids: string[]): string[] {
    this.allowedChatIds = sanitizeChatIds(ids.map(String));
    saveAllowedChats(this.dataDir, this.allowedChatIds);
    if (this.allowedChatIds.size > 0) this.claimWindowExpiresAt = 0;
    return [...this.allowedChatIds];
  }

  /** Open the owner-claim window: the next chat to message the bot becomes
   *  its owner. Only meaningful while the bot is unowned — an owned bot
   *  must be cleared first, so a claim window can never silently transfer
   *  ownership away from the current owner. */
  openOwnerClaimWindow(): { ok: boolean; msRemaining: number; error?: string } {
    if (this.allowedChatIds.size > 0) {
      return { ok: false, msRemaining: 0, error: "Bot already has an owner. Clear the owner first to re-claim." };
    }
    this.claimWindowExpiresAt = Date.now() + CLAIM_WINDOW_MS;
    logger.info(`[telegram] Owner-claim window open for ${CLAIM_WINDOW_MS / 1000}s`);
    return { ok: true, msRemaining: CLAIM_WINDOW_MS };
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
          const id = Number(update.update_id);
          const prior = this.pendingUpdates.get(id);
          if (!prior) {
            const state = { done: false, delivered: false };
            this.pendingUpdates.set(id, state);
            this.pendingUpdateOrder.push(id);
            this.runPendingUpdate(update, token, state);
          } else if (prior.done && !prior.delivered) {
            prior.done = false;
            this.runPendingUpdate(update, token, prior);
          }
        }
        while (this.pendingUpdateOrder.length > 0) {
          const id = this.pendingUpdateOrder[0];
          const state = this.pendingUpdates.get(id);
          if (!state?.done || !state.delivered) break;
          this.pendingUpdateOrder.shift();
          this.pendingUpdates.delete(id);
          this.offset = id + 1;
        }
        if (this.pendingUpdateOrder.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        consecutiveErrors++;
        const delay = pollBackoffDelay(consecutiveErrors);
        logger.error(`[telegram] Poll error (attempt ${consecutiveErrors}, retry in ${Math.round(delay / 1000)}s): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private runPendingUpdate(update: any, token: string, state: { done: boolean; delivered: boolean }): void {
    void this.handleUpdate(update, token)
      .then((delivered) => { state.delivered = delivered !== false; state.done = true; })
      .catch((error: Error) => { logger.error(`[telegram] Update ${update.update_id} failed: ${error.message}`); state.done = true; });
  }

  private async handleUpdate(update: any, token: string): Promise<boolean | void> {
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat.id);
    const from = msg.from;
    const senderName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || chatId;

    // Unowned bot: claimable only inside an operator-opened window. Outside
    // it we default-deny, so a bot whose handle leaked can't be taken over by
    // whoever messages it first.
    if (this.allowedChatIds.size === 0) {
      if (claimWindowRemainingMs(this.claimWindowExpiresAt, Date.now()) === 0) {
        logger.warn(`[telegram] Rejected message from ${chatId} (${senderName}) — bot is unowned and no claim window is open`);
        await this.sendMessage(chatId, `This bot has no owner yet. Open Settings → Communication → Telegram, click "Claim ownership", then message the bot again within 2 minutes.`);
        return;
      }
      this.setAllowedChatIds([chatId]);
      logger.info(`[telegram] Owner claimed by chat ${chatId} (${senderName})`);
      await this.sendMessage(chatId, `Locked to your account. Only you can use this bot now.`);
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
    const preferVoiceReply = _voiceMirrorForChat.has(chatId);

    const safeName = (senderName || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
    const safeText = text.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
    logger.info(`[telegram] ${safeName} (${chatId}): ${safeText}${text.length > 80 ? "..." : ""}`);

    // /stop | /cancel — hard-kill the running turn. Intercepted BEFORE the
    // processingLock bounce so it works mid-turn (the bounce would otherwise
    // swallow it). Doesn't depend on the model cooperating.
    const cmd = controlCommandKey(text);
    if (cmd === "/stop" || cmd === "/cancel") {
      return this.dispatchInboundReply(token, chatId, await this.onMessage({
        from: chatId, name: senderName, text: cmd, sessionId,
        deliveryId: `update:${String(update.update_id)}`,
        deliveryFingerprint: JSON.stringify(msg),
        deliveryTarget: chatId, preferVoiceReply,
      }));
    }

    if (this.processingLock.has(chatId)) {
      return this.dispatchInboundReply(token, chatId, await this.onMessage({
        from: chatId, name: senderName, text, sessionId, intent: "steer",
        deliveryId: `update:${String(update.update_id)}`,
        deliveryFingerprint: JSON.stringify(msg), deliveryTarget: chatId, preferVoiceReply,
      }));
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
        deliveryFingerprint: JSON.stringify(msg),
        deliveryTarget: chatId, preferVoiceReply,
      });
      if (!(await this.dispatchInboundReply(token, chatId, reply))) return false;
    } catch (e) {
      logger.error(`[telegram] Agent error for ${chatId}:`, (e as Error).message);
      await this.sendMessage(chatId, "Something went wrong. Try again?");
      return false;
    } finally {
      clearInterval(typingInterval);
      this.processingLock.delete(chatId);
      _voiceMirrorForChat.delete(chatId);
    }
  }

  private async dispatchInboundReply(
    token: string,
    chatId: string,
    reply: Awaited<ReturnType<TelegramBridgeConfig["onMessage"]>>,
  ): Promise<boolean> {
    if (!reply) return true;
    if (typeof reply === "string") return dispatchReply(token, chatId, reply, reply);
    if (reply.deferDelivery) return false;
    let delivered: boolean;
    try { delivered = await dispatchReply(token, chatId, reply.text, reply.speakable ?? reply.text, reply); }
    catch (error) {
      await reply.acknowledgeDelivery?.(false).catch(() => {});
      throw error;
    }
    try { await reply.acknowledgeDelivery?.(delivered); }
    catch (error) { logger.error(`[telegram] Delivery acknowledgement failed for ${chatId}:`, (error as Error).message); }
    return delivered;
  }
}
