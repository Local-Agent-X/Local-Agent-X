/**
 * WhatsApp Bridge via Baileys (WhatsApp Web protocol)
 *
 * Scan QR code → connected. No Meta Business API, no webhooks, no public URL.
 *
 * Architecture:
 *   WhatsApp message → Baileys (WA Web) → this bridge → runAgent() → Baileys send → WhatsApp reply
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

// ── Types ──

export interface WhatsAppBridgeConfig {
  dataDir: string;  // ~/.sax — session auth persisted here
  onMessage: (params: {
    from: string;
    name: string;
    text: string;
    sessionId: string;
  }) => Promise<string>;
}

type ConnectionState = "disconnected" | "connecting" | "qr" | "connected";

interface QueuedMessage {
  from: string;
  name: string;
  text: string;
  timestamp: number;
}

// ── WhatsApp Bridge ──

export class WhatsAppBridge {
  private dataDir: string;
  private authDir: string;
  private onMessage: WhatsAppBridgeConfig["onMessage"];
  private sock: any = null;
  private state: ConnectionState = "disconnected";
  private qrCode: string | null = null;
  private qrDataUrl: string | null = null;
  private processingLock = new Set<string>();
  private processedMessages = new Set<string>();
  private phoneNumber: string | null = null;
  private selfLid: string | null = null; // Owner's @lid JID for self-chat detection
  private lastError: string | null = null;
  private allowedNumbers: Set<string> = new Set(); // Empty = owner-only (default-deny)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WhatsAppBridgeConfig) {
    this.dataDir = config.dataDir;
    this.authDir = join(config.dataDir, "whatsapp-auth");
    this.onMessage = config.onMessage;

    // Load allowed numbers from config
    this.loadAllowedNumbers();

    // Prune dedup cache periodically
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
        // May already be disconnected
        try { this.sock.end(); } catch {}
      }
      this.sock = null;
    }
    this.state = "disconnected";
    this.qrCode = null;
    this.qrDataUrl = null;
    this.phoneNumber = null;
    console.log("[whatsapp] Disconnected");
  }

  /** Reset auth — removes saved session, forces new QR scan */
  async reset(): Promise<void> {
    await this.disconnect();
    if (existsSync(this.authDir)) {
      rmSync(this.authDir, { recursive: true, force: true });
      console.log("[whatsapp] Auth state cleared — will need new QR scan");
    }
  }

  /** Send a message to a WhatsApp number */
  async sendMessage(to: string, text: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") {
      console.error("[whatsapp] Cannot send — not connected");
      return false;
    }

    const jid = this.toJid(to);
    const chunks = this.splitMessage(text, 4000);

    for (const chunk of chunks) {
      try {
        await this.sock.sendMessage(jid, { text: chunk });
      } catch (e) {
        console.error("[whatsapp] Send error:", (e as Error).message);
        return false;
      }
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  /** Send an image (buffer) with optional caption. */
  async sendImage(to: string, image: Buffer, caption?: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") {
      console.error("[whatsapp] Cannot send image — not connected");
      return false;
    }
    const jid = this.toJid(to);
    try {
      await this.sock.sendMessage(jid, { image, caption: caption || "" });
      return true;
    } catch (e) {
      console.error("[whatsapp] sendImage error:", (e as Error).message);
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
    this.allowedNumbers = new Set(
      numbers.map(n => n.replace(/\D/g, "")).filter(n => n.length >= 7 && n.length <= 15)
    );
    this.saveAllowedNumbers();
  }

  // ── Private ──

  private async startSocket(): Promise<void> {
    // Baileys integration
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
      browser: ["Open Agent X", "cli", "1.0"],
      logger: silentLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // LID lookup for resolving @lid JIDs to phone numbers (critical for self-chat)
    const lidLookup = this.sock.signalRepository?.lidMapping;

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds);

    // Connection state changes
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
        console.log("[whatsapp] QR code ready — scan with WhatsApp → Linked Devices → Link a Device");
      }

      if (connection === "close") {
        this.qrCode = null;
        this.qrDataUrl = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const reason = statusCode || "unknown";

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[whatsapp] Logged out — clearing session");
          this.state = "disconnected";
          this.sock = null;
          if (existsSync(this.authDir)) {
            rmSync(this.authDir, { recursive: true, force: true });
          }
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          console.log("[whatsapp] Connection replaced by another session — stopped.");
          this.state = "disconnected";
          this.lastError = "Connection replaced by another WhatsApp Web session. Close other sessions first, then reconnect.";
          this.sock = null;
        } else {
          console.log(`[whatsapp] Disconnected (reason: ${reason}) — reconnecting in 5s...`);
          this.state = "connecting";
          this.reconnectTimer = setTimeout(() => {
            this.startSocket().catch(e => {
              console.error("[whatsapp] Reconnect failed:", (e as Error).message);
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
        // Strip both @lid suffix AND :device suffix from lid (e.g. "ABC123:5@lid" → "ABC123")
        this.selfLid = me?.lid?.replace(/@.*$/, "").split(":")[0] || null;
        console.log(`[whatsapp] Connected as ${this.phoneNumber} (lid=${this.selfLid})`);
        // Send available presence
        try { this.sock.sendPresenceUpdate("available"); } catch {}
      }
    });

    // Track JIDs we're currently replying to — any fromMe message to these JIDs is our agent's reply
    const replyingTo = new Set<string>();

    // Incoming messages handler
    const handleMessagesUpsert = async (upsert: any) => {
      const { messages, type } = upsert;

      // Accept both "notify" (new incoming) and "append" (self-chat / catch-up)
      if (type !== "notify" && type !== "append") return;

      const connectedAtMs = Date.now();

      for (const msg of messages) {
        const remoteJid = msg.key.remoteJid || "";
        const fromMe = msg.key.fromMe;

        // Skip status broadcasts
        if (remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@status")) continue;
        // Skip group messages for now
        if (remoteJid.endsWith("@g.us")) continue;

        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || null;

        if (text && (typeof text !== "string" || text.length > 10000)) continue;

        // Sanitize: strip zero-width, RTL/LTR overrides, and other invisible control characters
        // that could be used to hide prompt injection payloads
        const sanitizedText = text?.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u034F\u061C\u180E\u2060-\u2069\uFFF9-\uFFFB]/g, "")
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") || null;

        // Self-chat detection: match remoteJid against known owner JIDs.
        // Do NOT rely on LID resolution (it can return wrong mappings).
        // Instead, compare the exact JID against the two forms we know:
        //   1. "ownerPhone@s.whatsapp.net" (legacy)
        //   2. "ownerLid@lid" (post-migration)
        const selfJid = this.phoneNumber ? `${this.phoneNumber}@s.whatsapp.net` : null;
        const selfLidJid = this.selfLid ? `${this.selfLid}@lid` : null;
        const isSelfChat = fromMe && (remoteJid === selfJid || remoteJid === selfLidJid);

        // Resolve sender phone for access control (incoming messages from others)
        let senderPhone = remoteJid.split("@")[0];
        if (!isSelfChat && remoteJid.endsWith("@lid") && lidLookup) {
          try {
            const resolved = await lidLookup.get?.(remoteJid);
            if (resolved) senderPhone = String(resolved).split("@")[0];
          } catch {}
        }

        console.log(`[whatsapp] MSG: fromMe=${fromMe} jid=${remoteJid} phone=${senderPhone} selfChat=${isSelfChat} text="${String(text || "").slice(0, 50).replace(/[\x00-\x1f\x7f]/g, "")}"`);

        // - fromMe=true + self-chat = user messaging themselves → allow (talk to the agent)
        // - fromMe=true + NOT self-chat = outbound to someone else → skip
        // - fromMe=false = message from someone else → allow
        if (fromMe && !isSelfChat) continue;

        // If we're currently replying to this JID, skip (it's the agent's own reply coming back)
        if (fromMe && replyingTo.has(remoteJid)) continue;

        if (!sanitizedText) {
          const msgType = Object.keys(msg.message || {})[0] || "unknown";
          console.log(`[whatsapp] Ignoring ${msgType} from ${remoteJid}`);
          continue;
        }

        // Dedup
        const msgId = msg.key.id;
        if (!msgId || this.processedMessages.has(msgId)) continue;
        this.processedMessages.add(msgId);

        // For "append" type, skip old messages (only process recent ones)
        if (type === "append") {
          const msgTs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : 0;
          if (msgTs < connectedAtMs - 60_000) continue;
        }

        // Use real phone number for self-chat sessions (not the LID)
        const phone = isSelfChat ? (this.phoneNumber || senderPhone) : senderPhone;

        // Check allowed numbers — DEFAULT-DENY: only owner + explicitly allowed numbers
        const isOwner = this.phoneNumber && phone === this.phoneNumber;
        if (!isOwner && !this.allowedNumbers.has(phone)) {
          console.log(`[whatsapp] BLOCKED message from ${phone} (not owner or in allowed list)`);
          continue;
        }

        const name = msg.pushName || phone;
        const sessionId = `wa-${phone}`;

        const safeName = (name || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
        const safeText = text.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
        console.log(`[whatsapp] → ${safeName} (${phone}): ${safeText}${text.length > 80 ? "..." : ""}`);

        // Mark as read (skip for self-chat)
        if (!isSelfChat) {
          try { await this.sock.readMessages([{ remoteJid, id: msgId, fromMe: false }]); } catch {}
        }

        // Prevent concurrent agent runs for same person
        if (this.processingLock.has(phone)) {
          await this.sendMessage(phone, "Still working on your last message...");
          continue;
        }

        // Reply to the same JID the message came from (important for @lid self-chat)
        const replyJid = remoteJid;

        // "composing" presence expires in ~20s — re-send every 15s so the
        // user sees a continuous typing indicator while the agent works.
        const sendTyping = () => this.sock?.sendPresenceUpdate("composing", replyJid).catch(() => {});
        sendTyping();
        const typingInterval = setInterval(sendTyping, 15000);

        this.processingLock.add(phone);
        replyingTo.add(replyJid);
        try {
          const reply = await this.onMessage({ from: phone, name, text: sanitizedText, sessionId });
          if (reply) {
            await this.sendToJid(replyJid, reply);
          }
        } catch (e) {
          console.error(`[whatsapp] Agent error for ${phone}:`, (e as Error).message);
          await this.sendToJid(replyJid, "Something went wrong. Try again?");
        } finally {
          clearInterval(typingInterval);
          try { await this.sock?.sendPresenceUpdate("paused", replyJid); } catch {}
          // Small delay before clearing — gives time for the sent message event to be processed
          setTimeout(() => replyingTo.delete(replyJid), 3000);
          this.processingLock.delete(phone);
        }
      }
    };

    // Register message handler — try all available patterns
    this.sock.ev.on("messages.upsert", handleMessagesUpsert);
    this.sock.ev.process((events: any) => {
      if (events["messages.upsert"]) {
        handleMessagesUpsert(events["messages.upsert"]);
      }
    });

  }

  /** Send directly to a JID (used internally for replying to the correct chat) */
  private async sendToJid(jid: string, text: string): Promise<boolean> {
    if (!this.sock || this.state !== "connected") return false;
    const chunks = this.splitMessage(text, 4000);
    for (const chunk of chunks) {
      try {
        await this.sock.sendMessage(jid, { text: chunk });
      } catch (e) {
        console.error("[whatsapp] Send error:", (e as Error).message);
        return false;
      }
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  private toJid(phone: string): string {
    const clean = phone.replace(/\D/g, "");
    return clean.includes("@") ? clean : `${clean}@s.whatsapp.net`;
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

  private loadAllowedNumbers(): void {
    try {
      const cfgPath = join(this.dataDir, "whatsapp-config.json");
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8"));
        if (Array.isArray(cfg.allowedNumbers)) {
          this.allowedNumbers = new Set(cfg.allowedNumbers);
        }
      }
    } catch {}
  }

  private saveAllowedNumbers(): void {
    try {
      const cfgPath = join(this.dataDir, "whatsapp-config.json");
      const cfg = { allowedNumbers: [...this.allowedNumbers] };
      require("node:fs").writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch (e) {
      console.error("[whatsapp] Failed to save config:", (e as Error).message);
    }
  }
}
