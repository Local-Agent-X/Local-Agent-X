/**
 * Telegram Bot Bridge
 *
 * Chat with your agent via Telegram. Create a bot with @BotFather,
 * paste the token, connect. No libraries — pure HTTP to Telegram Bot API.
 * Uses long polling (getUpdates) — no webhook, no public URL needed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "./logger.js";
import { encodeWavToOgg, isFfmpegAvailable, transcribeOggBuffer, getVoicePref, splitForVoiceChunks } from "./bridge-voice/index.js";
import { synthesize } from "./voice.js";
const logger = createLogger("telegram-bridge");

// Per-turn flag: when the user sent a voice note in, we reply via voice
// regardless of the toggle state for that single response. Keyed by chatId.
// Cleared after the reply is dispatched. This avoids widening BridgeHandler
// — the bridge already owns inbound/outbound side-effects so keeping the
// voice-vs-text decision local is the smaller surgery.
const _voiceMirrorForChat = new Set<string>();
// Tracks chats we've already told "voice engine is down" so the hint only
// fires once per server-uptime per chat — avoids spamming every reply when
// the engine is offline. Resets on server restart so a fresh boot re-arms.
const _voiceFailHintSent = new Set<string>();

// ── Types ──

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
  }) => Promise<string | import("./whatsapp-bridge.js").BridgeReply>;
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
          logger.error(`[telegram] Send failed: ${result.description}`);
          return false;
        }
      } catch (e) {
        logger.error("[telegram] Send error:", (e as Error).message);
        return false;
      }
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  /** Send an OGG/Opus buffer as a Telegram voice note (rendered as a
   *  playable bubble in chat, not an attached file). */
  async sendVoice(chatId: string, ogg: Buffer): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      const blob = new Blob([ogg], { type: "audio/ogg" });
      form.append("voice", blob, "reply.ogg");
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      });
      const result = await res.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        logger.error(`[telegram] sendVoice failed: ${result.description}`);
        return false;
      }
      return true;
    } catch (e) {
      logger.error("[telegram] sendVoice error:", (e as Error).message);
      return false;
    }
  }

  /** Send a photo (buffer) with optional caption. */
  async sendPhoto(chatId: string, image: Buffer, caption?: string): Promise<boolean> {
    const token = this.getToken();
    if (!token || this.state !== "connected") return false;

    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption.slice(0, 1024));
      const blob = new Blob([image], { type: "image/jpeg" });
      form.append("photo", blob, "screenshot.jpg");

      const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
      });
      const result = await res.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        logger.error(`[telegram] sendPhoto failed: ${result.description}`);
        return false;
      }
      return true;
    } catch (e) {
      logger.error("[telegram] sendPhoto error:", (e as Error).message);
      return false;
    }
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
            logger.error(`[telegram] ${consecutiveErrors} consecutive errors — stopping. Reconnect from Settings.`);
            this.state = "error";
            this.lastError = result.description || "Too many poll errors";
            this.polling = false;
            return;
          }
          const delay = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000);
          logger.error(`[telegram] Poll error (${consecutiveErrors}/${MAX_ERRORS}): ${result.description}`);
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
          logger.error(`[telegram] ${consecutiveErrors} consecutive errors — stopping. Reconnect from Settings.`);
          this.state = "error";
          this.lastError = (e as Error).message;
          this.polling = false;
          return;
        }
        const delay = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000);
        logger.error(`[telegram] Poll error (${consecutiveErrors}/${MAX_ERRORS}): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * Detect voice/audio/photo/video/document messages, download the file, and
   * return a text description the agent can reason about. Returns empty string
   * if the message has nothing we know how to forward.
   */
  private async describeNonTextMessage(msg: any, token: string): Promise<string> {
    let fileId = ""; let kind = ""; let extra = "";
    if (msg.voice) { fileId = msg.voice.file_id; kind = "voice"; extra = `${msg.voice.duration || "?"}s, ${msg.voice.mime_type || "audio/ogg"}`; }
    else if (msg.audio) { fileId = msg.audio.file_id; kind = "audio"; extra = `${msg.audio.duration || "?"}s, ${msg.audio.mime_type || "audio/mpeg"}, title=${msg.audio.title || "?"}`; }
    else if (msg.video) { fileId = msg.video.file_id; kind = "video"; extra = `${msg.video.duration || "?"}s, ${msg.video.mime_type || "video/mp4"}, ${msg.video.width}x${msg.video.height}`; }
    else if (msg.video_note) { fileId = msg.video_note.file_id; kind = "video_note"; extra = `${msg.video_note.duration || "?"}s`; }
    else if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) { const largest = msg.photo[msg.photo.length - 1]; fileId = largest.file_id; kind = "photo"; extra = `${largest.width}x${largest.height}`; }
    else if (msg.document) { fileId = msg.document.file_id; kind = "document"; extra = `${msg.document.mime_type || "unknown"}, ${msg.document.file_name || "unnamed"}`; }
    else if (msg.sticker) { fileId = msg.sticker.file_id; kind = "sticker"; extra = msg.sticker.emoji || ""; }

    if (!fileId) return "";
    try {
      const localPath = await this.downloadTelegramFile(token, fileId, kind);
      const caption = typeof msg.caption === "string" ? ` Caption: "${msg.caption}".` : "";
      return `[User sent a ${kind} message via Telegram. Saved locally at ${localPath}. Metadata: ${extra}.${caption} If handling this requires a capability you don't have yet (transcription, OCR, video analysis), use self_edit to add it — then re-read this file.]`;
    } catch (e) {
      logger.error(`[telegram] Failed to download ${kind}:`, (e as Error).message);
      return `[User sent a ${kind} message via Telegram but download failed: ${(e as Error).message}. Tell the user you couldn't process it.]`;
    }
  }

  /** Download a Telegram-hosted file to ~/.lax/uploads, return the absolute path. */
  private async downloadTelegramFile(token: string, fileId: string, kind: string): Promise<string> {
    const info = await this.apiCall(token, "getFile", { file_id: fileId }, false);
    if (!info.ok || !info.result?.file_path) throw new Error(info.description || "getFile failed");
    const remotePath: string = info.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const uploadsDir = join(homedir(), ".lax", "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const ext = (remotePath.split(".").pop() || "bin").toLowerCase();
    const fname = `tg-${kind}-${Date.now()}.${ext}`;
    const fullPath = join(uploadsDir, fname);
    writeFileSync(fullPath, buf);
    return fullPath;
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
    // transcribeOggBuffer returns null and we fall through to the old path.
    // When we DO get a transcript, mark this turn as voice-mirrored so the
    // reply goes back as a voice note regardless of the per-chat toggle.
    let text = typeof msg.text === "string" ? msg.text : "";
    if (!text && msg.voice && msg.voice.file_id) {
      try {
        const info = await this.apiCall(token, "getFile", { file_id: msg.voice.file_id }, false);
        if (info.ok && info.result?.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
          const res = await fetch(fileUrl);
          if (res.ok) {
            const oggBuf = Buffer.from(await res.arrayBuffer());
            const transcript = await transcribeOggBuffer(oggBuf);
            if (transcript && transcript.trim()) {
              text = transcript.trim();
              _voiceMirrorForChat.add(chatId);
              logger.info(`[telegram] transcribed voice (${oggBuf.length}B): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
            }
          }
        }
      } catch (e) {
        logger.warn(`[telegram] voice transcribe failed: ${(e as Error).message}`);
      }
    }
    if (!text) {
      text = await this.describeNonTextMessage(msg, token) || "";
    }
    if (!text) return;
    if (text.length > 10000) {
      await this.sendMessage(chatId, "Message too long (max 10,000 characters).");
      return;
    }
    const sessionId = `tg-${chatId}`;

    const safeName = (senderName || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
    const safeText = text.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
    logger.info(`[telegram] ${safeName} (${chatId}): ${safeText}${text.length > 80 ? "..." : ""}`);

    if (this.processingLock.has(chatId)) {
      await this.sendMessage(chatId, "Still working on your last message...");
      return;
    }

    // Typing indicator — Telegram's typing state expires in ~5s, so we
    // re-send every 4s until the turn ends. Without this, long-running
    // agent turns (30s+) leave the user staring at a blank chat with no
    // signal that anything is happening.
    const sendTyping = () => this.apiCall(token, "sendChatAction", { chat_id: chatId, action: "typing" }, false).catch(() => {});
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    this.processingLock.add(chatId);
    try {
      const reply = await this.onMessage({ from: chatId, name: senderName, text, sessionId });
      if (!reply) { /* nothing to send */ }
      else if (typeof reply === "string") {
        await this.dispatchReply(chatId, reply, reply);
      } else {
        await this.dispatchReply(chatId, reply.text, reply.speakable ?? reply.text);
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

  /**
   * Send the agent's reply, choosing voice vs text per-chat. Voice mode is
   * active when the user has /voice on, OR when this turn was triggered by
   * an inbound voice note (mirror-the-channel for that one reply).
   *
   * Long replies in voice mode: send the FIRST sentence as a voice note,
   * then the full text as a follow-up message. Voice notes much over a
   * minute feel obnoxious in messaging apps.
   *
   * Failure paths: any TTS / encode / send-voice failure falls back to
   * sendMessage(text) so the user always gets the reply.
   */
  private async dispatchReply(chatId: string, textForWire: string, speakable: string): Promise<void> {
    const wantVoice = getVoicePref("telegram", chatId) || _voiceMirrorForChat.has(chatId);
    if (!wantVoice) {
      await this.sendMessage(chatId, textForWire);
      return;
    }

    const sendWithHintOnce = async (text: string, hint: string) => {
      if (_voiceFailHintSent.has(chatId)) {
        await this.sendMessage(chatId, text);
        return;
      }
      _voiceFailHintSent.add(chatId);
      await this.sendMessage(chatId, `${text}\n\n— ${hint}`);
    };

    if (!(await isFfmpegAvailable())) {
      logger.warn("[telegram] voice reply requested but ffmpeg unavailable — sending text");
      await sendWithHintOnce(textForWire, "Voice replies need ffmpeg installed on the server. Falling back to text until that's fixed.");
      return;
    }

    // Voice-only mode: split long replies into multiple voice notes at
    // paragraph/sentence boundaries. The previous "speak first sentence,
    // send rest as text" was wrong for the "transcribe this report so I
    // can listen" use case — user wanted the WHOLE thing audible.
    // Telegram voice notes hold ~50MB / over an hour at Opus, so we have
    // huge headroom. Cap each chunk at 3000 chars (~2-3 min audio) to
    // keep individual notes loadable on slow connections.
    const chunks = splitForVoiceChunks(speakable, 3000);
    let anySent = false;
    for (const chunk of chunks) {
      try {
        const wav = await synthesize(chunk);
        const ogg = await encodeWavToOgg(wav);
        const ok = await this.sendVoice(chatId, ogg);
        if (ok) { anySent = true; continue; }
        logger.warn("[telegram] sendVoice returned false on chunk — bailing to text fallback");
        break;
      } catch (e) {
        logger.warn(`[telegram] voice synthesis failed on chunk: ${(e as Error).message} — bailing to text fallback`);
        break;
      }
    }
    if (!anySent) {
      await sendWithHintOnce(textForWire, "Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.");
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
        join(this.dataDir, "telegram-config.json"),
        JSON.stringify({ allowedChatIds: [...this.allowedChatIds] }, null, 2),
      );
    } catch (e) {
      logger.error("[telegram] Failed to save config:", (e as Error).message);
    }
  }
}
