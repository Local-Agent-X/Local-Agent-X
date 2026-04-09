/**
 * Telegram Bot Bridge
 *
 * Chat with your agent via Telegram. Create a bot with @BotFather,
 * paste the token, connect. No libraries — pure HTTP to Telegram Bot API.
 * Uses long polling (getUpdates) — no webhook, no public URL needed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ──

export interface TelegramBridgeConfig {
  dataDir: string;
  getToken: () => string | null;
  onMessage: (params: {
    from: string;
    name: string;
    text: string;
    sessionId: string;
  }) => Promise<string>;
}

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

// ── Telegram Bridge ──

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
      const me = await this.apiCall(token, "getMe", undefined, false);
      if (!me.ok) throw new Error(me.description || "Invalid bot token");
      this.botUser = me.result;

      // Flush any stale Telegram-side long-poll so we don't get "terminated by other getUpdates"
      try {
        const flush = await this.apiCall(token, "getUpdates", { offset: -1, timeout: 0 }, false);
        if (flush.ok && flush.result?.length) {
          this.offset = flush.result[flush.result.length - 1].update_id + 1;
        }
      } catch {}

      // Re-load allowed chats in case config was updated while disconnected
      this.loadAllowedChats();

      this.state = "connected";
      console.log(`[telegram] Connected as @${this.botUser!.username} (${this.botUser!.first_name})`);
      this.startPolling(token);
      return { state: "connected", botUsername: this.botUser!.username, botName: this.botUser!.first_name };
    } catch (e) {
      this.state = "error";
      this.lastError = (e as Error).message;
      console.error("[telegram] Connect failed:", this.lastError);
      return { state: "error" };
    }
  }

  /** Disconnect: stop polling */
  disconnect(): void {
    this.stopPolling();
    this.state = "disconnected";
    this.botUser = null;
    this.lastError = null;
    console.log("[telegram] Disconnected");
  }

  /** Send a text message to a Telegram chat */
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;

    const chunks = this.splitMessage(text, 4000);
    for (const chunk of chunks) {
      try {
        // The channel-formatter produces MarkdownV2-escaped text (escaping
        // ( ) . ! - + = | { } # > ~ etc.). Telegram's legacy "Markdown"
        // mode doesn't recognize those escapes and renders the literal
        // backslashes — so we MUST send with MarkdownV2 to match.
        let result = await this.apiCall(token, "sendMessage", {
          chat_id: chatId, text: chunk, parse_mode: "MarkdownV2",
        }, false);
        // Parse failed — strip backslash escapes and send as plain text
        // so the user at least gets a readable message.
        if (!result.ok && result.description?.includes("parse")) {
          const plain = chunk.replace(/\\([_*\[\]()~>#+\-=|{}.!`])/g, "$1");
          result = await this.apiCall(token, "sendMessage", { chat_id: chatId, text: plain }, false);
        }
        if (!result.ok) {
          console.error(`[telegram] Send failed: ${result.description}`);
          return false;
        }
      } catch (e) {
        console.error("[telegram] Send error:", (e as Error).message);
        return false;
      }
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
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

  private async apiCall(token: string, method: string, body?: Record<string, unknown>, usePollSignal = true): Promise<any> {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const opts: RequestInit = {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };
    if (usePollSignal && this.pollAbort) opts.signal = this.pollAbort.signal;
    const res = await fetch(url, opts);
    return res.json();
  }

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
    const MAX_ERRORS = 10;

    while (this.polling) {
      try {
        const result = await this.apiCall(token, "getUpdates", {
          offset: this.offset, timeout: 30, allowed_updates: ["message"],
        }, true);

        if (!result.ok) {
          consecutiveErrors++;
          if (result.error_code === 401) {
            this.state = "error";
            this.lastError = "Bot token is invalid or revoked.";
            this.polling = false;
            return;
          }
          if (consecutiveErrors >= MAX_ERRORS) {
            console.error(`[telegram] ${consecutiveErrors} consecutive errors — stopping. Reconnect from Settings.`);
            this.state = "error";
            this.lastError = result.description || "Too many poll errors";
            this.polling = false;
            return;
          }
          const delay = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000);
          console.error(`[telegram] Poll error (${consecutiveErrors}/${MAX_ERRORS}): ${result.description}`);
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
        if (consecutiveErrors >= MAX_ERRORS) {
          console.error(`[telegram] ${consecutiveErrors} consecutive errors — stopping. Reconnect from Settings.`);
          this.state = "error";
          this.lastError = (e as Error).message;
          this.polling = false;
          return;
        }
        const delay = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000);
        console.error(`[telegram] Poll error (${consecutiveErrors}/${MAX_ERRORS}): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private async handleUpdate(update: any, token: string): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const from = msg.from;
    const senderName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || chatId;

    // Security: require explicit owner configuration — no auto-lock to first message
    if (this.allowedChatIds.size === 0 && !this.ownerVerified) {
      console.warn(`[telegram] Rejected message from ${chatId} (${senderName}) — no owner configured yet`);
      await this.sendMessage(chatId, `This bot has no owner configured yet. Please set your chat ID in the web UI settings before using Telegram.`);
      return;
    }

    if (!this.allowedChatIds.has(chatId)) {
      console.log(`[telegram] Blocked message from unauthorized chat ${chatId} (${senderName})`);
      await this.sendMessage(chatId, `Access denied. This bot is locked to its owner.`);
      return;
    }

    const text = msg.text;
    if (!text || typeof text !== "string") return;
    if (text.length > 10000) {
      await this.sendMessage(chatId, "Message too long (max 10,000 characters).");
      return;
    }
    const sessionId = `tg-${chatId}`;

    const safeName = (senderName || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
    const safeText = text.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
    console.log(`[telegram] ${safeName} (${chatId}): ${safeText}${text.length > 80 ? "..." : ""}`);

    if (this.processingLock.has(chatId)) {
      await this.sendMessage(chatId, "Still working on your last message...");
      return;
    }

    // Typing indicator
    this.apiCall(token, "sendChatAction", { chat_id: chatId, action: "typing" }, false).catch(() => {});

    this.processingLock.add(chatId);
    try {
      const reply = await this.onMessage({ from: chatId, name: senderName, text, sessionId });
      if (reply) await this.sendMessage(chatId, reply);
    } catch (e) {
      console.error(`[telegram] Agent error for ${chatId}:`, (e as Error).message);
      await this.sendMessage(chatId, "Something went wrong. Try again?");
    } finally {
      this.processingLock.delete(chatId);
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
      if (splitAt < maxLen * 0.5) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  private loadAllowedChats(): void {
    try {
      const cfgPath = join(this.dataDir, "telegram-config.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.length > 0) {
          this.allowedChatIds = new Set(cfg.allowedChatIds.map(String));
          this.ownerVerified = true;
          console.log(`[telegram] Loaded ${this.allowedChatIds.size} allowed chat(s) from config`);
        }
      }
    } catch (e) {
      console.error("[telegram] Failed to load telegram-config.json:", (e as Error).message);
      // Don't set ownerVerified — allow auto-lock to work on next message
      // so the real owner can reclaim the bot after a config corruption
    }
  }

  private saveAllowedChats(): void {
    try {
      writeFileSync(
        join(this.dataDir, "telegram-config.json"),
        JSON.stringify({ allowedChatIds: [...this.allowedChatIds] }, null, 2),
      );
    } catch (e) {
      console.error("[telegram] Failed to save config:", (e as Error).message);
    }
  }
}
