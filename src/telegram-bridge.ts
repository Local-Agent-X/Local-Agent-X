/**
 * Telegram Bot Bridge
 *
 * Chat with your agent via Telegram. Create a bot with @BotFather,
 * paste the token, connect. No libraries — pure HTTP to Telegram Bot API.
 * Uses long polling (getUpdates) — no webhook, no public URL needed.
 */

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

  constructor(config: TelegramBridgeConfig) {
    this.dataDir = config.dataDir;
    this.getToken = config.getToken;
    this.onMessage = config.onMessage;
    this.loadAllowedChats();
  }

  /** Connect: validate token via getMe, start long polling */
  async connect(): Promise<{ state: ConnectionState; botUsername?: string; botName?: string }> {
    if (this.state === "connected") {
      return { state: "connected", botUsername: this.botUser?.username, botName: this.botUser?.first_name };
    }

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
        let result = await this.apiCall(token, "sendMessage", {
          chat_id: chatId, text: chunk, parse_mode: "Markdown",
        }, false);
        // Markdown failed — fall back to plain text
        if (!result.ok && result.description?.includes("parse")) {
          result = await this.apiCall(token, "sendMessage", { chat_id: chatId, text: chunk }, false);
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
    while (this.polling) {
      try {
        const result = await this.apiCall(token, "getUpdates", {
          offset: this.offset, timeout: 30, allowed_updates: ["message"],
        }, true);

        if (!result.ok) {
          console.error("[telegram] Poll error:", result.description);
          if (result.error_code === 401) {
            this.state = "error";
            this.lastError = "Bot token is invalid or revoked.";
            this.polling = false;
            return;
          }
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        for (const update of result.result || []) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update, token);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        console.error("[telegram] Poll error:", (e as Error).message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async handleUpdate(update: any, token: string): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const from = msg.from;
    const senderName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || chatId;

    // Auto-lock: if no allowed chats configured yet, lock to the first person who messages
    if (this.allowedChatIds.size === 0) {
      this.allowedChatIds.add(chatId);
      this.saveAllowedChats();
      console.log(`[telegram] Auto-locked to chat ${chatId} (${senderName}) — first user to message`);
      await this.sendMessage(chatId, `Locked to your account. Only you can use this bot now.`);
    }

    if (!this.allowedChatIds.has(chatId)) {
      console.log(`[telegram] Blocked message from ${chatId} (not in allowed list)`);
      return;
    }

    const text = msg.text;
    const sessionId = `tg-${chatId}`;

    console.log(`[telegram] ${senderName} (${chatId}): ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

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
      const { existsSync, readFileSync } = require("node:fs");
      const { join } = require("node:path");
      const cfgPath = join(this.dataDir, "telegram-config.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (Array.isArray(cfg.allowedChatIds)) this.allowedChatIds = new Set(cfg.allowedChatIds);
      }
    } catch {}
  }

  private saveAllowedChats(): void {
    try {
      const { writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      writeFileSync(join(this.dataDir, "telegram-config.json"), JSON.stringify({ allowedChatIds: [...this.allowedChatIds] }, null, 2));
    } catch (e) {
      console.error("[telegram] Failed to save config:", (e as Error).message);
    }
  }
}
