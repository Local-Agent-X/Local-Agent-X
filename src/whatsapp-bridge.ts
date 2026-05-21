/**
 * WhatsApp Bridge via Baileys (WhatsApp Web protocol)
 *
 * Scan QR code → connected. No Meta Business API, no webhooks, no
 * public URL.
 *
 * Architecture:
 *   WhatsApp message → Baileys (WA Web) → this bridge → runAgent() →
 *   Baileys send → WhatsApp reply
 *
 * Setup:
 *   1. Hit POST /api/whatsapp/connect
 *   2. QR code appears in the response (and terminal)
 *   3. Scan it with WhatsApp on your phone (Linked Devices → Link a Device)
 *   4. Done — your agent is now on WhatsApp
 */

import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
// @ts-ignore — no types for qrcode
import QRCode from "qrcode";

import { createLogger } from "./logger.js";
import type { ConnectionState, WhatsAppBridgeConfig, BridgeReply } from "./whatsapp-bridge/types.js";
import { splitMessage, toJid } from "./whatsapp-bridge/text-utils.js";
import { loadAllowedNumbers, saveAllowedNumbers, sanitizeNumbers } from "./whatsapp-bridge/allowed-numbers.js";
import { dispatchReplyToJid } from "./whatsapp-bridge/voice-reply.js";
import { createMessagesUpsertHandler } from "./whatsapp-bridge/message-handler.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const logger = createLogger("whatsapp-bridge");

export type { BridgeReply, WhatsAppBridgeConfig } from "./whatsapp-bridge/types.js";

export class WhatsAppBridge {
  private dataDir: string;
  private authDir: string;
  onMessage: WhatsAppBridgeConfig["onMessage"];
  sock: any = null;
  state: ConnectionState = "disconnected";
  private qrCode: string | null = null;
  private qrDataUrl: string | null = null;
  processingLock = new Set<string>();
  processedMessages = new Set<string>();
  phoneNumber: string | null = null;
  selfLid: string | null = null; // Owner's @lid JID for self-chat detection
  private lastError: string | null = null;
  allowedNumbers: Set<string> = new Set(); // Empty = owner-only (default-deny)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WhatsAppBridgeConfig) {
    this.dataDir = config.dataDir;
    this.authDir = join(config.dataDir, "whatsapp-auth");
    this.onMessage = config.onMessage;

    this.allowedNumbers = loadAllowedNumbers(this.dataDir);

    // Prune dedup cache periodically — protects against unbounded growth
    // on long-lived sessions. 500-entry floor is enough to dedupe the
    // last ~12-24h of message activity for an active chat.
    setInterval(() => {
      if (this.processedMessages.size > 2000) {
        const entries = [...this.processedMessages];
        this.processedMessages = new Set(entries.slice(-500));
      }
    }, 30 * 60_000);
  }

  /** Start WhatsApp connection — generates QR code if not already paired */
  async connect(): Promise<{ state: ConnectionState; qr?: string; qrDataUrl?: string; phone?: string }> {
    if (this.state === "connected") {
      return { state: "connected", phone: this.phoneNumber || undefined };
    }
    if (this.state === "connecting") {
      return { state: "connecting", qr: this.qrCode || undefined, qrDataUrl: this.qrDataUrl || undefined };
    }

    this.state = "connecting";
    this.lastError = null;

    try {
      await this.startSocket();
    } catch (e) {
      this.state = "disconnected";
      this.lastError = (e as Error).message;
      throw e;
    }

    // Wait up to 5s for QR or connection
    for (let i = 0; i < 50; i++) {
      if (this.qrCode || (this.state as ConnectionState) === "connected") break;
      await new Promise(r => setTimeout(r, 100));
    }

    return {
      state: this.state,
      qr: this.qrCode || undefined,
      qrDataUrl: this.qrDataUrl || undefined,
      phone: this.phoneNumber || undefined,
    };
  }

  /** Disconnect cleanly */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try { this.sock.end(); } catch {}
      }
      this.sock = null;
    }
    this.state = "disconnected";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    logger.info("[whatsapp] Disconnected");
  }

  /** Reset auth — removes saved session, forces new QR scan */
  async reset(): Promise<void> {
    await this.disconnect();
    if (existsSync(this.authDir)) {
      rmSync(this.authDir, { recursive: true, force: true });
      logger.info("[whatsapp] Auth state cleared — will need new QR scan");
    }
  }

  /** Send a message to a WhatsApp number */
  async sendMessage(to: string, text: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") {
      logger.error("[whatsapp] Cannot send — not connected");
      return false;
    }
    return this.sendToJid(toJid(to), text);
  }

  /** Send an OGG/Opus buffer as a WhatsApp voice note (ptt=true so it
   *  renders as a playable voice bubble, not an attached audio file). */
  async sendVoiceToJid(jid: string, ogg: Buffer): Promise<boolean> {
    if (!this.sock || this.state !== "connected") return false;
    try {
      await this.sock.sendMessage(jid, {
        audio: ogg,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
      return true;
    } catch (e) {
      logger.error("[whatsapp] sendVoice error:", (e as Error).message);
      return false;
    }
  }

  /** Send an image (buffer) with optional caption. */
  async sendImage(to: string, image: Buffer, caption?: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") {
      logger.error("[whatsapp] Cannot send image — not connected");
      return false;
    }
    try {
      await this.sock.sendMessage(toJid(to), { image, caption: caption || "" });
      return true;
    } catch (e) {
      logger.error("[whatsapp] sendImage error:", (e as Error).message);
      return false;
    }
  }

  /** Get current status (with rendered QR image as data URL) */
  async getStatus(): Promise<{
    state: ConnectionState;
    phone: string | null;
    qr: string | null;
    qrDataUrl: string | null;
    qrImageUrl: string | null;
    error: string | null;
    allowedNumbers: string[];
    hasSavedSession: boolean;
  }> {
    let qrImageUrl: string | null = null;
    if (this.qrCode) {
      try {
        qrImageUrl = await QRCode.toDataURL(this.qrCode, { width: 280, margin: 2 });
      } catch {}
    }
    return {
      state: this.state,
      phone: this.phoneNumber,
      qr: this.qrCode,
      qrDataUrl: this.qrDataUrl,
      qrImageUrl,
      error: this.lastError,
      allowedNumbers: [...this.allowedNumbers],
      hasSavedSession: existsSync(join(this.authDir, "creds.json")),
    };
  }

  /** Set which phone numbers can message the agent (in addition to owner) */
  setAllowedNumbers(numbers: string[]): void {
    this.allowedNumbers = sanitizeNumbers(numbers);
    saveAllowedNumbers(this.dataDir, this.allowedNumbers);
  }

  /** Send directly to a JID. Public so the message-handler module can
   *  invoke it as part of its context. */
  async sendToJid(jid: string, text: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") return false;
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      try {
        await this.sock.sendMessage(jid, { text: chunk });
      } catch (e) {
        logger.error("[whatsapp] Send error:", (e as Error).message);
        return false;
      }
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  /** Voice/text reply dispatcher. Public so the message-handler module
   *  can invoke it. Delegates to the standalone voice-reply helper —
   *  this method just supplies the bridge's send callbacks. */
  async dispatchReplyToJid(jid: string, phone: string, reply: BridgeReply): Promise<void> {
    return dispatchReplyToJid(
      { sendToJid: (j, t) => this.sendToJid(j, t), sendVoiceToJid: (j, o) => this.sendVoiceToJid(j, o) },
      jid,
      phone,
      reply,
    );
  }

  private async startSocket(): Promise<void> {
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = (baileys as any).default ?? baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

    mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const silentLogger = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
      error: console.error, fatal: console.error,
    } as any;

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: ["Local Agent X", "cli", "1.0"],
      logger: silentLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    const lidLookup = this.sock.signalRepository?.lidMapping;

    this.sock.ev.on("creds.update", saveCreds);

    // Connection state changes — QR generation, disconnect classification,
    // reconnect scheduling, connected-state stamping.
    this.sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.state = "qr";
        this.qrDataUrl = qr;
        try {
          const qrt = require("qrcode-terminal");
          qrt.generate(qr, { small: true });
        } catch {}
        logger.info("[whatsapp] QR code ready — scan with WhatsApp → Linked Devices → Link a Device");
      }

      if (connection === "close") {
        this.qrCode = null;
        this.qrDataUrl = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const reason = statusCode || "unknown";

        if (statusCode === DisconnectReason.loggedOut) {
          logger.info("[whatsapp] Logged out — clearing session");
          this.state = "disconnected";
          this.sock = null;
          if (existsSync(this.authDir)) {
            rmSync(this.authDir, { recursive: true, force: true });
          }
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          logger.info("[whatsapp] Connection replaced by another session — stopped.");
          this.state = "disconnected";
          this.lastError = "Connection replaced by another WhatsApp Web session. Close other sessions first, then reconnect.";
          this.sock = null;
        } else {
          logger.info(`[whatsapp] Disconnected (reason: ${reason}) — reconnecting in 5s...`);
          this.state = "connecting";
          this.reconnectTimer = setTimeout(() => {
            this.startSocket().catch(e => {
              logger.error("[whatsapp] Reconnect failed:", (e as Error).message);
              this.state = "disconnected";
              this.lastError = (e as Error).message;
            });
          }, 5000);
        }
      }

      if (connection === "open") {
        this.state = "connected";
        this.qrCode = null;
        this.qrDataUrl = null;
        const me = this.sock?.user;
        this.phoneNumber = me?.id?.split(":")[0] || me?.id || null;
        // Strip both @lid suffix AND :device suffix from lid
        // (e.g. "ABC123:5@lid" → "ABC123")
        this.selfLid = me?.lid?.replace(/@.*$/, "").split(":")[0] || null;
        logger.info(`[whatsapp] Connected as ${this.phoneNumber} (lid=${this.selfLid})`);
        try { this.sock.sendPresenceUpdate("available"); } catch {}
      }
    });

    // Incoming message processing lives in src/whatsapp-bridge/
    // message-handler.ts. The handler structural-types `this` —
    // mutations to processedMessages / processingLock propagate.
    const handleMessagesUpsert = createMessagesUpsertHandler(this, lidLookup);

    // Register message handler — try all available patterns.
    this.sock.ev.on("messages.upsert", handleMessagesUpsert);
    this.sock.ev.process((events: any) => {
      if (events["messages.upsert"]) {
        handleMessagesUpsert(events["messages.upsert"]);
      }
    });
  }
}
