// messages.upsert handler — the inbound message-processing loop.
//
// Per-message flow:
//   1. Skip status/group/broadcast JIDs and own outbound (unless self-chat)
//   2. If voice note, transcribe via bridge-voice STT
//   3. Sanitize text (strip zero-width / control chars used in injection)
//   4. Self-chat detection (compare remoteJid to owner's lid / phone JIDs)
//   5. Dedup by msg.key.id; skip stale "append" history
//   6. Allow-list gate (owner + explicit allowedNumbers; default-deny)
//   7. Concurrent-call lock per phone
//   8. Run agent via ctx.onMessage; dispatch reply (voice or text)
//
// Context is the WhatsAppBridge instance — structural typing means we
// read/mutate the same Sets the class holds (processedMessages,
// processingLock). Reassignments of scalar fields (sock, phoneNumber)
// are read fresh on each invocation via ctx.X access.

import { createLogger } from "../logger.js";
import { markVoiceMirror, clearVoiceMirror, dispatchReplyToJid } from "./voice-reply.js";
import type { BridgeReply, WhatsAppBridgeConfig } from "./types.js";

const logger = createLogger("whatsapp-bridge");

export interface MessageHandlerContext {
  readonly phoneNumber: string | null;
  readonly selfLid: string | null;
  readonly allowedNumbers: Set<string>;
  readonly processedMessages: Set<string>;
  readonly processingLock: Set<string>;
  readonly sock: any;
  readonly onMessage: WhatsAppBridgeConfig["onMessage"];
  sendMessage(to: string, text: string): Promise<boolean>;
  sendToJid(jid: string, text: string): Promise<boolean>;
  sendVoiceToJid(jid: string, ogg: Buffer): Promise<boolean>;
}

export function createMessagesUpsertHandler(
  ctx: MessageHandlerContext,
  lidLookup: any,
): (upsert: any) => Promise<void> {
  // Track JIDs we're currently replying to — any fromMe message to these
  // JIDs is our agent's reply, not a fresh user message to process.
  const replyingTo = new Set<string>();
  const connectedAtMs = Date.now();

  return async function handleMessagesUpsert(upsert: any): Promise<void> {
    const { messages, type } = upsert;

    // Accept both "notify" (new incoming) and "append" (self-chat / catch-up)
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || "";
      const fromMe = msg.key.fromMe;

      if (remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@status")) continue;
      if (remoteJid.endsWith("@g.us")) continue; // group messages — out of scope

      let text: string | null =
        msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || null;

      // Inbound voice note (ptt) → transcribe via the bridge-voice STT
      // helper. On success, mark this turn as voice-mirrored so the
      // reply goes back as a voice note. On failure (no ffmpeg, no
      // whisper, hallucination filter) fall through and the "audio
      // without text" branch logs + skips below.
      const audioMsg = msg.message?.audioMessage;
      if (!text && audioMsg) {
        try {
          const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
          const { transcribeOggBuffer } = await import("../bridge-voice/index.js");
          const oggBuf = await downloadMediaMessage(msg as any, "buffer", {}) as Buffer;
          if (oggBuf && oggBuf.length > 0) {
            const transcript = await transcribeOggBuffer(oggBuf);
            if (transcript && transcript.trim()) {
              text = transcript.trim();
            }
          }
        } catch (e) {
          logger.warn(`[whatsapp] voice transcribe failed: ${(e as Error).message}`);
        }
      }

      if (text && (typeof text !== "string" || text.length > 10000)) continue;

      // Strip zero-width, RTL/LTR overrides, and other invisible control
      // characters that could be used to hide prompt injection payloads.
      const sanitizedText = text?.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u034F\u061C\u180E\u2060-\u2069\uFFF9-\uFFFB]/g, "")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") || null;

      // Self-chat detection: match remoteJid against known owner JIDs.
      // Do NOT rely on LID resolution (it can return wrong mappings).
      // Compare exact JID against the two forms we know:
      //   1. "ownerPhone@s.whatsapp.net" (legacy)
      //   2. "ownerLid@lid" (post-migration)
      const selfJid = ctx.phoneNumber ? `${ctx.phoneNumber}@s.whatsapp.net` : null;
      const selfLidJid = ctx.selfLid ? `${ctx.selfLid}@lid` : null;
      const isSelfChat = fromMe && (remoteJid === selfJid || remoteJid === selfLidJid);

      // Resolve sender phone for access control (incoming from others).
      let senderPhone = remoteJid.split("@")[0];
      if (!isSelfChat && remoteJid.endsWith("@lid") && lidLookup) {
        try {
          const resolved = await lidLookup.get?.(remoteJid);
          if (resolved) senderPhone = String(resolved).split("@")[0];
        } catch {}
      }

      logger.info(`[whatsapp] MSG: fromMe=${fromMe} jid=${remoteJid} phone=${senderPhone} selfChat=${isSelfChat} text="${String(text || "").slice(0, 50).replace(/[\x00-\x1f\x7f]/g, "")}"`);

      // fromMe=true + self-chat = user messaging themselves → allow
      // fromMe=true + NOT self-chat = outbound to someone else → skip
      // fromMe=false = message from someone else → allow
      if (fromMe && !isSelfChat) continue;

      // If we're currently replying to this JID, skip (agent's own reply).
      if (fromMe && replyingTo.has(remoteJid)) continue;

      if (!sanitizedText) {
        const msgType = Object.keys(msg.message || {})[0] || "unknown";
        logger.info(`[whatsapp] Ignoring ${msgType} from ${remoteJid}`);
        continue;
      }

      const msgId = msg.key.id;
      if (!msgId || ctx.processedMessages.has(msgId)) continue;
      ctx.processedMessages.add(msgId);

      // For "append" type, skip old messages (only process recent ones).
      if (type === "append") {
        const msgTs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : 0;
        if (msgTs < connectedAtMs - 60_000) continue;
      }

      // Use real phone number for self-chat sessions (not the LID).
      const phone = isSelfChat ? (ctx.phoneNumber || senderPhone) : senderPhone;

      // If the inbound was a transcribed voice note, mark this phone for
      // voice-mirror reply (handled by dispatchReplyToJid). Cleared in
      // finally regardless of outcome.
      if (audioMsg && text) markVoiceMirror(phone);

      // DEFAULT-DENY: only owner + explicitly allowed numbers.
      const isOwner = ctx.phoneNumber && phone === ctx.phoneNumber;
      if (!isOwner && !ctx.allowedNumbers.has(phone)) {
        logger.info(`[whatsapp] BLOCKED message from ${phone} (not owner or in allowed list)`);
        continue;
      }

      const name = msg.pushName || phone;
      const sessionId = `wa-${phone}`;

      const safeName = (name || "unknown").replace(/[\x00-\x1f\x7f]/g, "");
      const safeText = sanitizedText.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, "");
      logger.info(`[whatsapp] → ${safeName} (${phone}): ${safeText}${sanitizedText.length > 80 ? "..." : ""}`);

      // Mark as read (skip for self-chat).
      if (!isSelfChat) {
        try { await ctx.sock.readMessages([{ remoteJid, id: msgId, fromMe: false }]); } catch {}
      }

      // /stop | /cancel — hard-kill the running turn. Intercepted BEFORE the
      // processingLock bounce so it works mid-turn. Doesn't depend on the
      // model cooperating.
      const cmd = sanitizedText.trim().toLowerCase();
      if (cmd === "/stop" || cmd === "/cancel") {
        const { stopBridgeTurn } = await import("../bridge-control.js");
        const n = await stopBridgeTurn("whatsapp", phone, sessionId, "whatsapp-stop");
        await ctx.sendMessage(phone, n > 0 ? "🛑 Stopped." : "Nothing running.");
        continue;
      }

      // A message arriving mid-turn is steering the running turn — inject it
      // instead of bouncing. Falls back to the old notice only if the op
      // already finished out from under us.
      if (ctx.processingLock.has(phone)) {
        const { injectBridgeTurn } = await import("../bridge-control.js");
        const injected = await injectBridgeTurn("whatsapp", phone, sessionId, sanitizedText, "whatsapp-inject");
        await ctx.sendMessage(phone, injected ? "→ Got it — passing that to the running task." : "Still working on your last message...");
        continue;
      }

      // Reply to the same JID the message came from (important for @lid self-chat).
      const replyJid = remoteJid;

      // "composing" presence expires in ~20s — re-send every 15s so the
      // user sees a continuous typing indicator while the agent works.
      const sendTyping = () => ctx.sock?.sendPresenceUpdate("composing", replyJid).catch(() => {});
      sendTyping();
      const typingInterval = setInterval(sendTyping, 15000);

      ctx.processingLock.add(phone);
      replyingTo.add(replyJid);
      try {
        const replyRaw = await ctx.onMessage({ from: phone, name, text: sanitizedText, sessionId });
        const reply: BridgeReply | null = !replyRaw ? null
          : typeof replyRaw === "string" ? { text: replyRaw, speakable: replyRaw }
          : { text: replyRaw.text, speakable: replyRaw.speakable ?? replyRaw.text };
        if (reply) {
          await dispatchReplyToJid(
            { sendToJid: (j, t) => ctx.sendToJid(j, t), sendVoiceToJid: (j, o) => ctx.sendVoiceToJid(j, o) },
            replyJid,
            phone,
            reply,
          );
        }
      } catch (e) {
        logger.error(`[whatsapp] Agent error for ${phone}:`, (e as Error).message);
        await ctx.sendToJid(replyJid, "Something went wrong. Try again?");
      } finally {
        clearInterval(typingInterval);
        try { await ctx.sock?.sendPresenceUpdate("paused", replyJid); } catch {}
        // Small delay before clearing — gives time for the sent message
        // event to be processed.
        setTimeout(() => replyingTo.delete(replyJid), 3000);
        ctx.processingLock.delete(phone);
        clearVoiceMirror(phone);
      }
    }
  };
}
